/**
 * Core type definitions for the Memory Toolkit.
 *
 * Generalized for reuse across LLM memory systems.
 * These types form the foundation of the 4-layer memory architecture:
 *
 *   ① Working Memory  — current conversation context
 *   ② Episodic Memory — events/experiences with timestamps
 *   ③ Semantic Memory — facts/knowledge with vector retrieval
 *   ④ Procedural Memory — skills/tool usage records
 */

// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system" | "toolResult";

export interface BaseMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  timestamp?: number;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ToolResultMessage extends BaseMessage {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

export type ConversationMessage = BaseMessage | ToolResultMessage;

// ─── Memory Store Types ──────────────────────────────────────────

export interface MemoryEntry {
  content: string;
  metadata?: {
    source?: string;       // conversation | file | tool
    timestamp?: number;
    tags?: string[];
    importance?: number;   // 0-1
    chunkIndex?: number;   // set when auto-chunked
    totalChunks?: number;  // set when auto-chunked
  };
  embedding?: number[];    // optional; auto-generated if missing
}

export interface MemoryQuery {
  text: string;
  topK?: number;           // default 5
  minSimilarity?: number;  // default 0.35
  strategy?: "vector" | "fulltext" | "hybrid";
  timeDecay?: boolean;
  filter?: {
    source?: string;
    tags?: string[];
    since?: number;        // timestamp lower bound
  };
}

export interface MemorySearchResult {
  id: string;
  content: string;
  similarity: number;      // 0-1
  metadata?: MemoryEntry["metadata"];
}

export interface MemoryStats {
  totalEntries: number;
  totalTokens: number;
  cacheHitRate: number;
  lastUpdated: number;
}

// ─── Compaction Types ────────────────────────────────────────────

export interface CompactionParams {
  messages: ConversationMessage[];
  contextWindow: number;
  preserveRecentTurns?: number;  // default 3, max 12
  maxHistoryShare?: number;      // default 0.5
  qualityGuardEnabled?: boolean;
  qualityGuardMaxRetries?: number; // default 1, max 3
}

export interface CompactionResult {
  messages: ConversationMessage[];
  summary: string;
  summaryGenerated: boolean;
  tokensSaved: number;
  qualityReport?: QualityReport;
}

export interface QualityReport {
  passed: boolean;
  reasons: string[];
}

export interface CompactionPreparation {
  messagesToSummarize: ConversationMessage[];
  turnPrefixMessages: ConversationMessage[];
  previousSummary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  isSplitTurn?: boolean;
  settings: {
    reserveTokens: number;
  };
}

// ─── Session Types ───────────────────────────────────────────────

export interface Session {
  key: string;
  messages: ConversationMessage[];
  createdAt: number;
  lastActivityAt: number;
  tokenCount: number;
}

export interface SessionManagerOptions {
  maxConcurrent?: number;   // default 5000
  idleTtlMs?: number;       // default 86400000 (24h)
  evictionStrategy?: "LRU";
}

// ─── Embedding Provider Types ────────────────────────────────────

export interface EmbeddingProvider {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderId =
  | "openai"
  | "local"
  | "gemini"
  | "voyage"
  | "mistral"
  | "ollama";

export type EmbeddingProviderRequest = EmbeddingProviderId | "auto";
export type EmbeddingProviderFallback = EmbeddingProviderId | "none";

export interface EmbeddingProviderOptions {
  provider: EmbeddingProviderRequest;
  model: string;
  fallback?: EmbeddingProviderFallback;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  outputDimensionality?: number;
}

// ─── Memory Search Config Types ──────────────────────────────────

export interface MemorySearchConfig {
  enabled?: boolean;
  provider?: EmbeddingProviderRequest;
  model?: string;
  fallback?: EmbeddingProviderFallback;
  store?: {
    driver?: "sqlite";
    path?: string;
    vector?: {
      enabled?: boolean;
      extensionPath?: string;
    };
  };
  chunking?: {
    tokens?: number;    // default 400
    overlap?: number;   // default 80
  };
  sync?: {
    onSessionStart?: boolean;
    onSearch?: boolean;
    watch?: boolean;
    watchDebounceMs?: number;
    intervalMinutes?: number;
    sessions?: {
      deltaBytes?: number;
      deltaMessages?: number;
      postCompactionForce?: boolean;
    };
  };
  query?: {
    maxResults?: number;   // default 6
    minScore?: number;     // default 0.35
    hybrid?: {
      enabled?: boolean;
      vectorWeight?: number;     // default 0.7
      textWeight?: number;       // default 0.3
      candidateMultiplier?: number; // default 4
      mmr?: {
        enabled?: boolean;
        lambda?: number;         // default 0.7
      };
      temporalDecay?: {
        enabled?: boolean;
        halfLifeDays?: number;   // default 30
      };
    };
  };
  cache?: {
    enabled?: boolean;
    maxEntries?: number;
  };
}
