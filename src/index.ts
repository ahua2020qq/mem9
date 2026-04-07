/**
 * Mem9 — LLM Memory Toolkit
 *
 * Production-tested patterns for LLM context management.
 *
 * Components:
 *   1. Token Estimator       — CJK + Latin mixed-language token counting
 *   2. Adaptive Compaction   — intelligent conversation compression
 *   3. Quality Safeguard     — summary quality verification
 *   4. Compaction Guardian   — compression + quality retry loop
 *   5. Context Window Guard  — hard limits and warnings
 *   6. Bootstrap Budget      — startup file budget management
 *   7. Text Chunker          — semantic text splitting
 *   8. Memory Search Config  — hybrid retrieval with embedding-based MMR
 *   9. Embedding Provider    — vector embedding factory
 *  10. Memory Store          — in-memory store with vector + FTS search
 *  11. Session Manager       — LRU session lifecycle management
 *  12. Memory Flush          — cache refresh triggering
 *
 * @packageDocumentation
 */

// ─── Error Types ──────────────────────────────────────────────────
export {
  MemoryToolkitError,
  ValidationError,
  EmbeddingError,
  EmbeddingTimeoutError,
  CompactionError,
  StoreError,
  SqliteStoreError,
} from "./errors.js";

// ─── Core Types ──────────────────────────────────────────────────
export type {
  MessageRole,
  BaseMessage,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  ToolResultMessage,
  ConversationMessage,
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  MemoryStats,
  CompactionParams,
  CompactionResult,
  QualityReport,
  CompactionPreparation,
  Session,
  SessionManagerOptions,
  EmbeddingProvider,
  EmbeddingProviderId,
  EmbeddingProviderRequest,
  EmbeddingProviderFallback,
  EmbeddingProviderOptions,
  MemorySearchConfig,
} from "./types.js";

// ─── Token Estimation ────────────────────────────────────────────
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "./token-estimator.js";

// ─── Adaptive Compaction ─────────────────────────────────────────
export {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  pruneHistoryForContextShare,
  summarizeInStages,
  summarizeWithFallback,
  resolveContextWindowTokens,
} from "./compaction.js";
export type {
  SummarizeFunction,
  MergeSummariesFunction,
} from "./compaction.js";

// ─── Quality Safeguard ───────────────────────────────────────────
export {
  MAX_EXTRACTED_IDENTIFIERS,
  MAX_COMPACTION_SUMMARY_CHARS,
  REQUIRED_SUMMARY_SECTIONS,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  capCompactionSummaryPreservingSuffix,
  formatPreservedTurnsSection,
  formatToolFailuresSection,
  extractLatestUserAsk,
} from "./quality-safeguard.js";
export type {
  IdentifierPolicy,
  SafeguardOptions,
  QualityAuditResult,
} from "./quality-safeguard.js";

// ─── Compaction Guardian (retry loop) ─────────────────────────────
export { compactWithQualityGuard } from "./compaction-guardian.js";
export type {
  GuardianOptions,
  GuardianResult,
} from "./compaction-guardian.js";

// ─── Context Window Guard ────────────────────────────────────────
export {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from "./context-window-guard.js";
export type {
  ContextWindowLevel,
  ContextWindowInfo,
} from "./context-window-guard.js";

// ─── Bootstrap Budget ────────────────────────────────────────────
export {
  DEFAULT_BOOTSTRAP_MAX_FILE_CHARS,
  DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS,
  DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO,
  analyzeBootstrapBudget,
  buildBootstrapWarning,
} from "./bootstrap-budget.js";
export type {
  BootstrapFile,
  BootstrapBudgetAnalysis,
  BootstrapFileWithMetrics,
} from "./bootstrap-budget.js";

// ─── Text Chunker ────────────────────────────────────────────────
export {
  chunkText,
  chunkTexts,
  mergeSmallChunks,
} from "./text-chunker.js";
export type {
  ChunkingOptions,
  ChunkResult,
} from "./text-chunker.js";

// ─── Memory Search Config ────────────────────────────────────────
export {
  resolveMemorySearchConfig,
  computeTemporalDecay,
  computeMmrScore,
  mergeHybridResults,
} from "./memory-search-config.js";
export type {
  ResolvedMemorySearchConfig,
  HybridSearchResult,
} from "./memory-search-config.js";

// ─── Embedding Provider ──────────────────────────────────────────
export {
  createOpenAIEmbeddingProvider,
  createOllamaEmbeddingProvider,
  createGenericEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
  normalizeVector,
} from "./embedding-provider.js";
export type {
  EmbeddingProviderResult,
  OpenAIEmbeddingOptions,
  OllamaEmbeddingOptions,
} from "./embedding-provider.js";

// ─── Memory Store ────────────────────────────────────────────────
export { MemoryStore } from "./memory-store.js";
export type { MemoryStoreOptions } from "./memory-store.js";

// ─── Memory Cache ────────────────────────────────────────────────
export { MemoryCache } from "./memory-cache.js";
export type { MemoryCacheOptions } from "./memory-cache.js";

// ─── Memory Flush ────────────────────────────────────────────────
export {
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
  computeContextHash,
} from "./memory-flush.js";
export type {
  MemoryFlushParams,
  MemoryFlushDecision,
} from "./memory-flush.js";

// ─── Session Manager ─────────────────────────────────────────────
export { SessionManager } from "./session-manager.js";

// ─── SQLite Memory Store (optional, requires better-sqlite3) ────
export { SqliteMemoryStore } from "./sqlite-memory-store.js";
export type { SqliteMemoryStoreOptions } from "./sqlite-memory-store.js";
