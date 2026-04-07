/**
 * Quality Safeguard for Compaction Summaries
 *
 * Ensures LLM-generated summaries preserve critical information:
 *   - Structured sections (Decisions, TODOs, Constraints, Pending Asks, Identifiers)
 *   - Opaque identifier preservation (UUIDs, URLs, file paths, ports, etc.)
 *   - Latest user ask reflection in summary
 */

// ─── Constants ───────────────────────────────────────────────────

export const MAX_EXTRACTED_IDENTIFIERS = 12;
export const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
export const MAX_ASK_OVERLAP_TOKENS = 12;
export const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;

export const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";

// ─── Identifier Policy ───────────────────────────────────────────

export type IdentifierPolicy = "strict" | "off" | "custom";

export interface SafeguardOptions {
  identifierPolicy?: IdentifierPolicy;
  identifierInstructions?: string;
}

// ─── Structure Instructions ──────────────────────────────────────

/**
 * Build the structured instructions that tell the LLM what sections
 * the summary must contain.
 */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
  options?: SafeguardOptions,
): string {
  const identifierInstruction = resolveIdentifierInstruction(options);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierInstruction,
    "Do not omit unresolved asks from the user.",
  ].join("\n");

  const custom = customInstructions?.trim();
  if (!custom) return sectionsTemplate;

  return `${sectionsTemplate}\n\nAdditional context:\n${custom}`;
}

function resolveIdentifierInstruction(options?: SafeguardOptions): string {
  const policy = options?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return "For ## Exact identifiers, include identifiers only when needed for continuity.";
  }
  if (policy === "custom" && options?.identifierInstructions?.trim()) {
    return options.identifierInstructions.trim();
  }
  return (
    "For ## Exact identifiers, preserve literal values exactly as seen " +
    "(IDs, URLs, file paths, ports, hashes, dates, times)."
  );
}

// ─── Structured Fallback Summary ─────────────────────────────────

/**
 * Build a minimal structured summary as fallback when LLM summarization
 * is unavailable or has no content.
 */
export function buildStructuredFallbackSummary(
  previousSummary?: string,
): string {
  const trimmed = previousSummary?.trim() ?? "";
  if (trimmed && hasRequiredSummarySections(trimmed)) {
    return trimmed;
  }
  return [
    "## Decisions",
    trimmed || "No prior history.",
    "",
    "## Open TODOs",
    "None.",
    "",
    "## Constraints/Rules",
    "None.",
    "",
    "## Pending user asks",
    "None.",
    "",
    "## Exact identifiers",
    "None captured.",
  ].join("\n");
}

// ─── Identifier Extraction ───────────────────────────────────────

/**
 * Extract opaque identifiers from text: UUIDs, URLs, file paths,
 * host:port patterns, long numbers, etc.
 *
 * Returns up to MAX_EXTRACTED_IDENTIFIERS (12) unique identifiers.
 */
export function extractOpaqueIdentifiers(text: string): string[] {
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];

  return Array.from(
    new Set(
      matches
        .map((value) => sanitizeExtractedIdentifier(value))
        .map((value) => normalizeOpaqueIdentifier(value))
        .filter((value) => value.length >= 4),
    ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

// ─── Quality Audit ───────────────────────────────────────────────

export interface QualityAuditResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Audit summary quality. Checks:
 *   1. All required sections present
 *   2. All identifiers preserved (if strict policy)
 *   3. Latest user ask reflected in summary
 */
export function auditSummaryQuality(params: {
  summary: string;
  identifiers: string[];
  latestAsk: string | null;
  identifierPolicy?: IdentifierPolicy;
}): QualityAuditResult {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.summary));

  // Check required sections
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }

  // Check identifier preservation (strict mode only)
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }

  // Check latest ask reflection
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }

  return { ok: reasons.length === 0, reasons };
}

// ─── Summary Capping ─────────────────────────────────────────────

/**
 * Cap a summary to maxChars, appending a truncation marker if needed.
 */
export function capCompactionSummary(
  summary: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  if (maxChars <= 0 || summary.length <= maxChars) return summary;

  const marker = SUMMARY_TRUNCATED_MARKER;
  const budget = Math.max(0, maxChars - marker.length);
  if (budget <= 0) return summary.slice(0, maxChars);
  return `${summary.slice(0, budget)}${marker}`;
}

/**
 * Cap summary body while preserving a suffix (tool failures, file ops, etc.)
 * The suffix is always kept intact — the body is truncated to make room.
 */
export function capCompactionSummaryPreservingSuffix(
  body: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  if (!suffix) return capCompactionSummary(body, maxChars);
  if (maxChars <= 0) return capCompactionSummary(`${body}${suffix}`, maxChars);
  if (suffix.length >= maxChars) return suffix.slice(-maxChars);

  const bodyBudget = Math.max(0, maxChars - suffix.length);
  const cappedBody = capCompactionSummary(body, bodyBudget);
  return `${cappedBody}${suffix}`;
}

// ─── Preserved Turns Formatting ──────────────────────────────────

/**
 * Format preserved recent turns for inclusion in compaction summary.
 * Each turn is truncated to MAX_RECENT_TURN_TEXT_CHARS (600 chars).
 */
export function formatPreservedTurnsSection(
  messages: Array<{ role: string; content?: unknown }>,
): string {
  if (messages.length === 0) return "";

  const lines = messages
    .map((message) => {
      let roleLabel: string;
      if (message.role === "assistant") {
        roleLabel = "Assistant";
      } else if (message.role === "user") {
        roleLabel = "User";
      } else {
        return null;
      }

      const text = extractMessageText(message);
      if (!text) return null;

      const trimmed =
        text.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${text.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : text;
      return `- ${roleLabel}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) return "";
  return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}

/**
 * Format tool failures section for compaction summary.
 */
export function formatToolFailuresSection(
  failures: Array<{ toolName: string; summary: string; meta?: string }>,
): string {
  if (failures.length === 0) return "";

  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

// ─── Internal Helpers ────────────────────────────────────────────

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{8,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) return true;

  const askTokens = Array.from(new Set(tokenizeSimple(latestAsk))).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) return true;

  const summaryTokens = new Set(tokenizeSimple(summary));
  let overlapCount = 0;
  for (const token of askTokens) {
    if (summaryTokens.has(token)) overlapCount += 1;
  }

  const requiredMatches =
    askTokens.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return overlapCount >= requiredMatches;
}

function tokenizeSimple(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .normalize("NFKC")
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractMessageText(message: { content?: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ("type" in block && block.type === "text" && "text" in block) {
      const text = block.text;
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * Extract latest user ask from messages (searches from end).
 */
export function extractLatestUserAsk(
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;

    const text = extractMessageText(message);
    if (text) return text;
  }
  return null;
}
