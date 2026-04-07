/**
 * Memory Flush Triggering
 *
 * Determines when memory search caches should be refreshed and
 * when pre-flight compaction should be triggered.
 */

import { estimateMessagesTokens } from "./token-estimator.js";

// ─── Types ───────────────────────────────────────────────────────

export interface MemoryFlushParams {
  /** Total tokens used in current context */
  usedTokens: number;
  /** Total context window size */
  contextWindowTokens: number;
  /** Token count at which soft flush is triggered */
  softThresholdTokens: number;
  /** Token count at which force flush is triggered */
  hardThresholdTokens: number;
  /** Floor below which no flush is needed */
  reserveTokensFloor: number;
}

export interface MemoryFlushDecision {
  shouldFlush: boolean;
  isForceFlush: boolean;
  reason?: string;
}

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Determine if a memory flush should be triggered.
 *
 * Logic:
 *   - Below reserveTokensFloor → no flush
 *   - Near soft threshold → soft flush (refresh search cache)
 *   - Near hard threshold → force flush (compaction required)
 */
export function shouldRunMemoryFlush(params: MemoryFlushParams): MemoryFlushDecision {
  const {
    usedTokens,
    contextWindowTokens,
    softThresholdTokens,
    hardThresholdTokens,
    reserveTokensFloor,
  } = params;

  // Below floor — no action needed
  if (usedTokens < reserveTokensFloor) {
    return { shouldFlush: false, isForceFlush: false };
  }

  // Hard threshold — force compaction
  if (usedTokens >= hardThresholdTokens) {
    return {
      shouldFlush: true,
      isForceFlush: true,
      reason: `Token usage (${usedTokens}) reached hard threshold (${hardThresholdTokens}). Force compaction.`,
    };
  }

  // Soft threshold — refresh cache
  if (usedTokens >= softThresholdTokens) {
    return {
      shouldFlush: true,
      isForceFlush: false,
      reason: `Token usage (${usedTokens}) reached soft threshold (${softThresholdTokens}). Cache refresh.`,
    };
  }

  return { shouldFlush: false, isForceFlush: false };
}

/**
 * Check if pre-flight compaction should run before processing a new message.
 * Triggered when current usage exceeds a percentage of context window.
 */
export function shouldRunPreflightCompaction(params: {
  usedTokens: number;
  contextWindowTokens: number;
  threshold?: number;  // default 0.7
}): boolean {
  const threshold = params.threshold ?? 0.7;
  return params.usedTokens >= params.contextWindowTokens * threshold;
}

/**
 * Compute a hash of the current context for cache invalidation.
 * Uses token count + last message timestamp as a lightweight fingerprint.
 */
export function computeContextHash(messages: Array<{ content?: unknown; timestamp?: number }>): string {
  if (messages.length === 0) return "empty";

  const totalTokens = estimateMessagesTokens(messages);
  const lastTimestamp = messages[messages.length - 1]?.timestamp ?? 0;
  const messageCount = messages.length;

  return `${messageCount}:${totalTokens}:${lastTimestamp}`;
}
