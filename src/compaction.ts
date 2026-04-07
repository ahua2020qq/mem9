/**
 * Adaptive Compaction Engine
 *
 * The core algorithm that compresses conversation history to fit within
 * context windows while preserving critical information.
 *
 * Design principles (production-tested):
 *   - Compression over truncation — LLM summarization, not blind cuts
 *   - Adaptive ratio — larger messages → more aggressive compression
 *   - Progressive stages — split into chunks, summarize each, merge
 *   - Safety margin — 20% buffer for token estimation inaccuracy
 */

import type { ConversationMessage } from "./types.js";
import {
  estimateMessagesTokens,
  estimateMessageTokens,
} from "./token-estimator.js";

// ─── Constants ───────────────────────────────────────────────────

/** Base chunk ratio: compress history to 40% of context window */
export const BASE_CHUNK_RATIO = 0.4;

/** Minimum chunk ratio: never compress below 15% */
export const MIN_CHUNK_RATIO = 0.15;

/** Safety margin: 20% buffer for token estimation errors */
export const SAFETY_MARGIN = 1.2;

/** Overhead reserved for summarization prompt, system prompt, etc. */
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

/** Default number of parts to split messages into */
const DEFAULT_PARTS = 2;

/** Fallback summary text */
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";

// ─── Core Types ──────────────────────────────────────────────────

export type SummarizeFunction = (
  messages: ConversationMessage[],
  options: {
    maxTokens: number;
    reserveTokens: number;
    contextWindow: number;
    previousSummary?: string;
    customInstructions?: string;
    signal?: AbortSignal;
  },
) => Promise<string>;

export type MergeSummariesFunction = (
  summaries: string[],
  options: {
    maxTokens: number;
    signal?: AbortSignal;
  },
) => Promise<string>;

// ─── Adaptive Ratio ──────────────────────────────────────────────

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, use smaller chunks to avoid exceeding model limits.
 *
 * If average message > 10% of context window:
 *   reduction = min(avgRatio × 2, 25%)
 *   final = max(15%, 40% - reduction)
 * Otherwise: use base ratio 40%
 */
export function computeAdaptiveChunkRatio(
  messages: ConversationMessage[],
  contextWindow: number,
): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(
  message: ConversationMessage,
  contextWindow: number,
): boolean {
  const tokens = estimateMessageTokens(message) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

// ─── Message Splitting ───────────────────────────────────────────

/**
 * Split messages into N parts by token share.
 * Each part gets approximately equal total tokens.
 */
export function splitMessagesByTokenShare(
  messages: ConversationMessage[],
  parts = DEFAULT_PARTS,
): ConversationMessage[][] {
  if (messages.length === 0) return [];

  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) return [messages];

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Split messages into chunks where each chunk fits within maxTokens.
 * Applies SAFETY_MARGIN to compensate for token estimation inaccuracy.
 */
export function chunkMessagesByMaxTokens(
  messages: ConversationMessage[],
  maxTokens: number,
): ConversationMessage[][] {
  if (messages.length === 0) return [];

  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
  const chunks: ConversationMessage[][] = [];
  let currentChunk: ConversationMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > effectiveMax) {
      // Split oversized messages to avoid unbounded chunk growth
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ─── Pruning ─────────────────────────────────────────────────────

/**
 * Prune history to fit within a token budget.
 * Iteratively drops the oldest chunk until budget is met.
 *
 * Returns kept messages plus statistics about what was dropped.
 */
export function pruneHistoryForContextShare(params: {
  messages: ConversationMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;  // default 0.5
  parts?: number;            // default 2
}): {
  messages: ConversationMessage[];
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = [...params.messages];
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) break;

    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();

    droppedMessages += dropped.length;
    droppedTokens += estimateMessagesTokens(dropped);
    keptMessages = flatRest;
  }

  return {
    messages: keptMessages,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

// ─── Staged Summarization ────────────────────────────────────────

/**
 * Summarize messages in stages with progressive fallback.
 *
 * Algorithm:
 *  1. If messages fit in one chunk → summarize directly
 *  2. Split into N parts by token share
 *  3. Summarize each part independently
 *  4. Merge partial summaries into one cohesive summary
 *
 * Requires an external `summarize` function (calls your LLM).
 */
export async function summarizeInStages(params: {
  messages: ConversationMessage[];
  summarize: SummarizeFunction;
  mergeSummaries?: MergeSummariesFunction;
  contextWindow: number;
  reserveTokens: number;
  maxChunkTokens?: number;
  parts?: number;
  minMessagesForSplit?: number;
  previousSummary?: string;
  customInstructions?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const {
    messages,
    summarize,
    contextWindow,
    reserveTokens,
    parts: requestedParts = DEFAULT_PARTS,
    minMessagesForSplit = 4,
    previousSummary,
    customInstructions,
    signal,
  } = params;

  if (messages.length === 0) {
    return previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Compute adaptive chunk tokens
  const adaptiveRatio = computeAdaptiveChunkRatio(messages, contextWindow);
  const maxChunkTokens =
    params.maxChunkTokens ??
    Math.max(1, Math.floor(contextWindow * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS);

  const normalizedParts = normalizeParts(requestedParts, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  // If everything fits in one chunk, summarize directly
  if (
    normalizedParts <= 1 ||
    messages.length < Math.max(2, minMessagesForSplit) ||
    totalTokens <= maxChunkTokens
  ) {
    return summarizeWithFallback({
      messages,
      summarize,
      contextWindow,
      reserveTokens,
      maxChunkTokens,
      previousSummary,
      customInstructions,
      signal,
    });
  }

  // Split and summarize each part
  const splits = splitMessagesByTokenShare(messages, normalizedParts).filter(
    (chunk) => chunk.length > 0,
  );
  if (splits.length <= 1) {
    return summarizeWithFallback({
      messages,
      summarize,
      contextWindow,
      reserveTokens,
      maxChunkTokens,
      previousSummary,
      customInstructions,
      signal,
    });
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    const partial = await summarizeWithFallback({
      messages: chunk,
      summarize,
      contextWindow,
      reserveTokens,
      maxChunkTokens,
      previousSummary: undefined,
      customInstructions,
      signal,
    });
    partialSummaries.push(partial);
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  // Merge partial summaries
  if (params.mergeSummaries) {
    return params.mergeSummaries(partialSummaries, {
      maxTokens: maxChunkTokens,
      signal,
    });
  }

  // Default merge: feed summaries as messages to the summarizer
  const summaryMessages: ConversationMessage[] = partialSummaries.map((summary) => ({
    role: "user" as const,
    content: summary,
    timestamp: Date.now(),
  }));

  return summarizeWithFallback({
    messages: summaryMessages,
    summarize,
    contextWindow,
    reserveTokens,
    maxChunkTokens,
    previousSummary,
    customInstructions: [
      "Merge these partial summaries into a single cohesive summary.",
      "",
      "MUST PRESERVE:",
      "- Active tasks and their current status",
      "- Batch operation progress",
      "- The last thing requested and what was being done",
      "- Decisions made and their rationale",
      "- TODOs, open questions, and constraints",
      "- Any commitments or follow-ups promised",
      "",
      "PRIORITIZE recent context over older history.",
      ...(customInstructions ? ["", `Additional: ${customInstructions}`] : []),
    ].join("\n"),
    signal,
  });
}

/**
 * Summarize with progressive fallback for oversized messages.
 * If full summarization fails, tries excluding oversized messages.
 */
export async function summarizeWithFallback(params: {
  messages: ConversationMessage[];
  summarize: SummarizeFunction;
  contextWindow: number;
  reserveTokens: number;
  maxChunkTokens: number;
  previousSummary?: string;
  customInstructions?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { messages, summarize, contextWindow, reserveTokens, maxChunkTokens } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization
  try {
    return await summarize(messages, {
      maxTokens: maxChunkTokens,
      reserveTokens,
      contextWindow,
      previousSummary: params.previousSummary,
      customInstructions: params.customInstructions,
      signal: params.signal,
    });
  } catch (fullError) {
    // Fall through to partial
  }

  // Fallback: exclude oversized messages
  const smallMessages: ConversationMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = msg.role;
      const tokens = estimateMessageTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await summarize(smallMessages, {
        maxTokens: maxChunkTokens,
        reserveTokens,
        contextWindow,
        previousSummary: params.previousSummary,
        customInstructions: params.customInstructions,
        signal: params.signal,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partialSummary + notes;
    } catch {
      // Fall through
    }
  }

  // Final fallback
  return (
    `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
    `Summary unavailable due to size limits.`
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) return 1;
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

/**
 * Resolve context window tokens from model or default.
 */
export function resolveContextWindowTokens(contextWindow?: number, fallback = 200_000): number {
  return Math.max(1, Math.floor(contextWindow ?? fallback));
}
