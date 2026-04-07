/**
 * Bootstrap Budget Management
 *
 * Manages the token budget for bootstrap/startup files that are injected
 * into the LLM context at session start.
 *
 */

// ─── Constants ───────────────────────────────────────────────────

/** Maximum characters for a single bootstrap file */
export const DEFAULT_BOOTSTRAP_MAX_FILE_CHARS = 20_000;

/** Maximum total characters across all bootstrap files */
export const DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS = 150_000;

/** Ratio at which bootstrap is considered "near limit" */
export const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85;

// ─── Types ───────────────────────────────────────────────────────

export interface BootstrapFile {
  path: string;
  content: string;
  priority?: number;  // higher = more important, kept first
}

export interface BootstrapBudgetAnalysis {
  files: BootstrapFileWithMetrics[];
  totalChars: number;
  maxTotalChars: number;
  utilizationRatio: number;
  nearLimit: boolean;
  overLimit: boolean;
  warnings: string[];
}

export interface BootstrapFileWithMetrics extends BootstrapFile {
  charCount: number;
  overFileLimit: boolean;
  included: boolean;
}

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Analyze bootstrap files against budget constraints.
 *
 * Checks:
 *   - Individual file size vs max file chars
 *   - Total size vs max total chars
 *   - Near-limit warning
 *
 * Files are sorted by priority (descending) and included until budget is exhausted.
 */
export function analyzeBootstrapBudget(
  files: BootstrapFile[],
  options?: {
    maxFileChars?: number;
    maxTotalChars?: number;
    nearLimitRatio?: number;
  },
): BootstrapBudgetAnalysis {
  const maxFileChars = options?.maxFileChars ?? DEFAULT_BOOTSTRAP_MAX_FILE_CHARS;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS;
  const nearLimitRatio = options?.nearLimitRatio ?? DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO;

  const warnings: string[] = [];

  // Sort by priority (descending), then by path for stability
  const sorted = [...files].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return a.path.localeCompare(b.path);
  });

  let totalChars = 0;
  const fileMetrics: BootstrapFileWithMetrics[] = [];

  for (const file of sorted) {
    const charCount = file.content.length;
    const overFileLimit = charCount > maxFileChars;
    const projectedTotal = totalChars + charCount;
    const included = projectedTotal <= maxTotalChars;

    if (included) {
      totalChars = projectedTotal;
    }

    if (overFileLimit) {
      warnings.push(
        `File "${file.path}" (${charCount} chars) exceeds per-file limit (${maxFileChars} chars). ` +
          `It will be truncated.`,
      );
    }

    fileMetrics.push({
      ...file,
      charCount,
      overFileLimit,
      included,
    });
  }

  const utilizationRatio = totalChars / maxTotalChars;
  const nearLimit = utilizationRatio >= nearLimitRatio;
  const overLimit = totalChars > maxTotalChars;

  if (nearLimit && !overLimit) {
    warnings.push(
      `Bootstrap files are at ${(utilizationRatio * 100).toFixed(0)}% of budget. ` +
        `Consider reducing startup files.`,
    );
  }

  if (overLimit) {
    warnings.push(
      `Bootstrap files total ${totalChars} chars exceeds budget (${maxTotalChars} chars). ` +
        `Lower-priority files were excluded.`,
    );
  }

  return {
    files: fileMetrics,
    totalChars,
    maxTotalChars,
    utilizationRatio,
    nearLimit,
    overLimit,
    warnings,
  };
}

/**
 * Build a warning message for bootstrap budget near/over limit.
 */
export function buildBootstrapWarning(analysis: BootstrapBudgetAnalysis): string | null {
  if (analysis.warnings.length === 0) return null;

  const header = analysis.overLimit
    ? "Bootstrap budget exceeded:"
    : "Bootstrap budget warning:";

  return [header, ...analysis.warnings].join("\n  - ");
}
