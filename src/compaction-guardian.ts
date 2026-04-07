/**
 * Compaction Guardian — ties compaction + quality safeguard together.
 *
 * The retry loop that composes compaction with quality verification.
 *
 * Flow:
 *   1. Split messages into "to summarize" + "to preserve"
 *   2. Generate summary via user-provided LLM function
 *   3. Audit summary quality (sections, identifiers, ask reflection)
 *   4. If quality fails → retry with feedback (up to N times)
 *   5. Cap summary to budget, append preserved turns
 */

import type { ConversationMessage, TextBlock } from "./types.js";
import {
  summarizeInStages,
  type SummarizeFunction,
} from "./compaction.js";
import { estimateMessagesTokens, estimateTokens } from "./token-estimator.js";
import {
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  extractOpaqueIdentifiers,
  extractLatestUserAsk,
  capCompactionSummary,
  formatPreservedTurnsSection,
  REQUIRED_SUMMARY_SECTIONS,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "./quality-safeguard.js";

// ─── Types ───────────────────────────────────────────────────────

export interface GuardianOptions {
  /** Max quality retry attempts (default 1, max 3) */
  maxRetries?: number;
  /** Number of recent turns to preserve verbatim (default 3, max 12) */
  preserveRecentTurns?: number;
  /** Max chars per preserved turn (default 600) */
  maxCharsPerTurn?: number;
  /** Whether quality guard is enabled (default true) */
  qualityGuardEnabled?: boolean;
  /** Identifier policy (default "strict") */
  identifierPolicy?: "strict" | "off" | "custom";
  /** Custom summarization instructions */
  customInstructions?: string;
}

export interface GuardianResult {
  summary: string;
  attempts: number;
  qualityPassed: boolean;
  qualityReasons: string[];
  tokensSaved: number;
}

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 1;
const MAX_RETRIES_CAP = 3;
const DEFAULT_PRESERVE_TURNS = 3;
const MAX_PRESERVE_TURNS = 12;
const DEFAULT_MAX_CHARS_PER_TURN = 600;

// ─── Core Function ───────────────────────────────────────────────

/**
 * Run compaction with quality-guarded retry loop.
 *
 * This is the main entry point that ties compaction and quality
 * safeguard together. You provide a `summarize` function that
 * calls your LLM, and this function handles:
 *   - Adaptive chunk sizing
 *   - Quality verification with structured section requirements
 *   - Retry with feedback on quality failure
 *   - Summary capping and preserved turn formatting
 */
export async function compactWithQualityGuard(params: {
  messages: ConversationMessage[];
  summarize: SummarizeFunction;
  contextWindow: number;
  reserveTokens: number;
  previousSummary?: string;
  options?: GuardianOptions;
  signal?: AbortSignal;
}): Promise<GuardianResult> {
  const {
    messages,
    summarize,
    contextWindow,
    reserveTokens,
    previousSummary,
    signal,
  } = params;

  const opts = params.options ?? {};
  const maxRetries = Math.min(
    MAX_RETRIES_CAP,
    Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES),
  );
  const preserveTurns = Math.min(
    MAX_PRESERVE_TURNS,
    Math.max(0, opts.preserveRecentTurns ?? DEFAULT_PRESERVE_TURNS),
  );
  const qualityGuardEnabled = opts.qualityGuardEnabled ?? true;
  const identifierPolicy = opts.identifierPolicy ?? "strict";

  // Nothing to summarize
  if (messages.length === 0) {
    return {
      summary: previousSummary ?? "No prior history.",
      attempts: 0,
      qualityPassed: true,
      qualityReasons: [],
      tokensSaved: 0,
    };
  }

  const tokensBefore = estimateMessagesTokens(messages);

  // Split: preserve recent turns, summarize the rest
  const { toSummarize, toPreserve } = splitPreserveRecent(
    messages,
    preserveTurns,
  );

  // Extract identifiers and latest ask for quality checks
  const seedText = toSummarize
    .slice(-10)
    .map((m) => extractText(m))
    .filter(Boolean)
    .join("\n");
  const identifiers = extractOpaqueIdentifiers(seedText);
  const latestAsk = extractLatestUserAsk(messages);

  // Build instructions
  const baseInstructions = buildCompactionStructureInstructions(
    opts.customInstructions,
    { identifierPolicy },
  );

  // Retry loop — delegates chunking to summarizeInStages
  let currentInstructions = baseInstructions;
  let bestSummary: string | null = null;
  let lastQualityOk = false;
  let lastQualityReasons: string[] = [];
  const totalAttempts = qualityGuardEnabled ? maxRetries + 1 : 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    let summary: string;

    if (toSummarize.length > 0) {
      try {
        // Delegate all chunking + summarization to compaction engine
        summary = await summarizeInStages({
          messages: toSummarize,
          summarize,
          contextWindow,
          reserveTokens,
          previousSummary,
          customInstructions: currentInstructions,
          signal,
        });
      } catch (err) {
        if (attempt > 0 && bestSummary) {
          summary = bestSummary;
        } else {
          throw err;
        }
      }
    } else {
      summary = buildStructuredFallbackSummary(previousSummary);
    }

    bestSummary = summary;

    // Quality check
    if (!qualityGuardEnabled || toSummarize.length === 0) {
      lastQualityOk = true;
      break;
    }

    const quality = auditSummaryQuality({
      summary,
      identifiers,
      latestAsk,
      identifierPolicy,
    });

    lastQualityOk = quality.ok;
    lastQualityReasons = quality.reasons;

    if (quality.ok || attempt >= totalAttempts - 1) {
      break;
    }

    // Build feedback for retry
    const reasons = quality.reasons.join(", ");
    const feedback = buildQualityFeedback(reasons, identifierPolicy);
    currentInstructions = `${baseInstructions}\n\n${feedback}`;
  }

  // Append preserved turns
  const preservedSection = formatPreservedTurnsSection(toPreserve);
  const fullSummary = bestSummary
    ? appendSection(bestSummary, preservedSection)
    : preservedSection.trim();

  // Cap to budget
  const capped = capCompactionSummary(fullSummary, MAX_COMPACTION_SUMMARY_CHARS);

  const tokensAfter = estimateTokens(capped) + estimateMessagesTokens(toPreserve);

  return {
    summary: capped,
    attempts: totalAttempts,
    qualityPassed: lastQualityOk,
    qualityReasons: lastQualityReasons,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function splitPreserveRecent(
  messages: ConversationMessage[],
  preserveTurns: number,
): { toSummarize: ConversationMessage[]; toPreserve: ConversationMessage[] } {
  if (preserveTurns <= 0 || messages.length === 0) {
    return { toSummarize: messages, toPreserve: [] };
  }

  // Find user messages (turn boundaries)
  const userIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      userIndexes.push(i);
    }
  }

  if (userIndexes.length < preserveTurns) {
    // Not enough turns to split — keep all
    return { toSummarize: messages, toPreserve: [] };
  }

  // Boundary: start of the Nth-from-last user message
  const boundaryIndex = userIndexes[userIndexes.length - preserveTurns];
  if (boundaryIndex === undefined || boundaryIndex === 0) {
    return { toSummarize: messages, toPreserve: [] };
  }

  return {
    toSummarize: messages.slice(0, boundaryIndex),
    toPreserve: messages.slice(boundaryIndex),
  };
}

function extractText(message: ConversationMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is TextBlock =>
        b != null && typeof b === "object" && "type" in b && b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function appendSection(summary: string, section: string): string {
  if (!section) return summary;
  if (!summary.trim()) return section.trimStart();
  return `${summary}${section}`;
}

function buildQualityFeedback(
  reasons: string,
  policy: string,
): string {
  const fixInstruction =
    policy === "strict"
      ? "Fix all issues and include every required section with exact identifiers preserved."
      : "Fix all issues and include every required section while following the configured identifier policy.";

  return [
    `Quality check feedback: Previous summary failed (${reasons}).`,
    fixInstruction,
    `Required sections: ${REQUIRED_SUMMARY_SECTIONS.join(", ")}`,
  ].join("\n");
}
