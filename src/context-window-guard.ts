/**
 * Context Window Guard
 *
 * Hard limits and warnings for LLM context window management.
 * Prevents degradation when context window is too small.
 */

// ─── Constants ───────────────────────────────────────────────────

/** Hard minimum context window — below this, guard triggers */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;

/** Warning threshold — below this, warn but allow operation */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

/** Default context window for large models */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

// ─── Types ───────────────────────────────────────────────────────

export type ContextWindowLevel = "ok" | "warn" | "critical";

export interface ContextWindowInfo {
  tokens: number;
  level: ContextWindowLevel;
  message?: string;
}

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Resolve context window info with guard checks.
 *
 * Returns the effective token count and a severity level:
 *   - "ok":       >= 32K tokens
 *   - "warn":     16K-32K tokens
 *   - "critical": < 16K tokens
 */
export function resolveContextWindowInfo(contextWindow?: number): ContextWindowInfo {
  const tokens = Math.max(1, Math.floor(contextWindow ?? DEFAULT_CONTEXT_TOKENS));

  if (tokens < CONTEXT_WINDOW_HARD_MIN_TOKENS) {
    return {
      tokens,
      level: "critical",
      message: `Context window (${tokens} tokens) is below hard minimum (${CONTEXT_WINDOW_HARD_MIN_TOKENS}). ` +
        `Agent performance will be severely degraded.`,
    };
  }

  if (tokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS) {
    return {
      tokens,
      level: "warn",
      message: `Context window (${tokens} tokens) is below recommended minimum (${CONTEXT_WINDOW_WARN_BELOW_TOKENS}). ` +
        `Compaction may be aggressive.`,
    };
  }

  return { tokens, level: "ok" };
}

/**
 * Evaluate context window guard and throw or warn as needed.
 *
 * @param throwOnCritical - if true, throws on critical level
 * @returns ContextWindowInfo with severity assessment
 */
export function evaluateContextWindowGuard(
  contextWindow?: number,
  throwOnCritical = false,
): ContextWindowInfo {
  const info = resolveContextWindowInfo(contextWindow);

  if (info.level === "critical" && throwOnCritical) {
    throw new Error(info.message ?? "Context window below hard minimum");
  }

  return info;
}
