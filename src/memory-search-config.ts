/**
 * Memory Search Configuration
 *
 * Resolves and normalizes memory search settings with production-validated defaults.
 * Covers: chunking, hybrid retrieval, MMR, temporal decay, caching, and sync.
 */

import type { MemorySearchConfig } from "./types.js";
import { cosineSimilarity } from "./embedding-provider.js";

// ─── Default Values ──────────────────────────────────────────────

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = false;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = false;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;

// ─── Resolved Config Type ────────────────────────────────────────

export interface ResolvedMemorySearchConfig {
  enabled: boolean;
  provider: string;
  model: string;
  store: {
    driver: "sqlite";
    path: string;
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
      postCompactionForce: boolean;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: {
        enabled: boolean;
        lambda: number;
      };
      temporalDecay: {
        enabled: boolean;
        halfLifeDays: number;
      };
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
}

// ─── Core Function ───────────────────────────────────────────────

/**
 * Resolve memory search configuration with validated defaults.
 *
 * Merges user-provided config with production-tested defaults,
 * clamps all values to safe ranges, and normalizes weights.
 */
export function resolveMemorySearchConfig(
  config?: MemorySearchConfig,
  storePath?: string,
): ResolvedMemorySearchConfig {
  const enabled = config?.enabled ?? true;
  const provider = config?.provider ?? "auto";
  const model = config?.model ?? "";

  const vector = {
    enabled: config?.store?.vector?.enabled ?? true,
    extensionPath: config?.store?.vector?.extensionPath,
  };

  const store = {
    driver: (config?.store?.driver ?? "sqlite") as "sqlite",
    path: storePath ?? "./memory.sqlite",
    vector,
  };

  // Chunking with safe bounds
  const rawTokens = config?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS;
  const rawOverlap = config?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP;
  const chunking = {
    tokens: Math.max(1, rawTokens),
    overlap: clampNumber(rawOverlap, 0, Math.max(0, rawTokens - 1)),
  };

  // Sync settings
  const sync = {
    onSessionStart: config?.sync?.onSessionStart ?? true,
    onSearch: config?.sync?.onSearch ?? true,
    watch: config?.sync?.watch ?? true,
    watchDebounceMs: config?.sync?.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: config?.sync?.intervalMinutes ?? 0,
    sessions: {
      deltaBytes: clampInt(
        config?.sync?.sessions?.deltaBytes ?? DEFAULT_SESSION_DELTA_BYTES,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      deltaMessages: clampInt(
        config?.sync?.sessions?.deltaMessages ?? DEFAULT_SESSION_DELTA_MESSAGES,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      postCompactionForce: config?.sync?.sessions?.postCompactionForce ?? true,
    },
  };

  // Query settings
  const query = {
    maxResults: config?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: clampNumber(config?.query?.minScore ?? DEFAULT_MIN_SCORE, 0, 1),
  };

  // Hybrid retrieval with normalized weights
  const rawVectorWeight = config?.query?.hybrid?.vectorWeight ?? DEFAULT_HYBRID_VECTOR_WEIGHT;
  const rawTextWeight = config?.query?.hybrid?.textWeight ?? DEFAULT_HYBRID_TEXT_WEIGHT;
  const sum = rawVectorWeight + rawTextWeight;
  const normalizedVectorWeight = sum > 0 ? rawVectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? rawTextWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;

  const hybrid = {
    enabled: config?.query?.hybrid?.enabled ?? DEFAULT_HYBRID_ENABLED,
    vectorWeight: normalizedVectorWeight,
    textWeight: normalizedTextWeight,
    candidateMultiplier: clampInt(
      config?.query?.hybrid?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER,
      1,
      20,
    ),
    mmr: {
      enabled: config?.query?.hybrid?.mmr?.enabled ?? DEFAULT_MMR_ENABLED,
      lambda: clampNumber(config?.query?.hybrid?.mmr?.lambda ?? DEFAULT_MMR_LAMBDA, 0, 1),
    },
    temporalDecay: {
      enabled: config?.query?.hybrid?.temporalDecay?.enabled ?? DEFAULT_TEMPORAL_DECAY_ENABLED,
      halfLifeDays: (() => {
        const raw = config?.query?.hybrid?.temporalDecay?.halfLifeDays;
        return Math.max(1, Math.floor(
          raw != null && Number.isFinite(raw) ? raw : DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
        ));
      })(),
    },
  };

  const cache = {
    enabled: config?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries:
      typeof config?.cache?.maxEntries === "number" && Number.isFinite(config.cache.maxEntries)
        ? Math.max(1, Math.floor(config.cache.maxEntries))
        : undefined,
  };

  return {
    enabled,
    provider,
    model,
    store,
    chunking,
    sync,
    query: { ...query, hybrid },
    cache,
  };
}

// ─── Hybrid Retrieval Helpers ────────────────────────────────────

/**
 * Compute temporal decay multiplier for a given age.
 * Uses exponential decay: score × 0.5^(age / halfLife)
 */
export function computeTemporalDecay(
  ageDays: number,
  halfLifeDays: number,
): number {
  if (halfLifeDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Compute MMR (Maximal Marginal Relevance) score.
 * Balances relevance to query vs diversity from already-selected results.
 *
 * @param lambda - 1.0 = pure relevance, 0.0 = pure diversity
 */
export function computeMmrScore(params: {
  querySimilarity: number;
  maxSelectedSimilarity: number;
  lambda: number;
}): number {
  const { querySimilarity, maxSelectedSimilarity, lambda } = params;
  return lambda * querySimilarity - (1 - lambda) * maxSelectedSimilarity;
}

/**
 * Merge hybrid search results with weighted scoring.
 *
 * Combines vector (semantic) and text (keyword) search results using
 * configurable weights, then applies MMR for diversity.
 */
export interface HybridSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  /** Optional pre-computed embedding for MMR diversity calculation */
  embedding?: number[];
}

export function mergeHybridResults(params: {
  vectorResults: Array<HybridSearchResult>;
  textResults: Array<HybridSearchResult>;
  vectorWeight: number;
  textWeight: number;
  maxResults: number;
  mmrEnabled?: boolean;
  mmrLambda?: number;
  /** Cosine similarity function for MMR. Defaults to word overlap fallback. */
  similarityFn?: (a: number[], b: number[]) => number;
  temporalDecayEnabled?: boolean;
  temporalDecayHalfLifeDays?: number;
  nowMs?: number;
}): Array<HybridSearchResult> {
  const {
    vectorResults,
    textResults,
    vectorWeight,
    textWeight,
    maxResults,
    mmrEnabled = false,
    mmrLambda = 0.7,
    similarityFn,
    temporalDecayEnabled = false,
    temporalDecayHalfLifeDays = 30,
    nowMs = Date.now(),
  } = params;

  // Merge scores by ID
  const merged = new Map<
    string,
    {
      id: string;
      content: string;
      vectorScore: number;
      textScore: number;
      combinedScore: number;
      metadata?: Record<string, unknown>;
      timestamp?: number;
      embedding?: number[];
    }
  >();

  for (const result of vectorResults) {
    const existing = merged.get(result.id);
    const timestamp = typeof result.metadata?.timestamp === "number" ? result.metadata.timestamp : nowMs;
    let score = result.score * vectorWeight;

    // Apply temporal decay
    if (temporalDecayEnabled && timestamp < nowMs) {
      const ageDays = (nowMs - timestamp) / (1000 * 60 * 60 * 24);
      score *= computeTemporalDecay(ageDays, temporalDecayHalfLifeDays);
    }

    if (existing) {
      existing.vectorScore = score;
      existing.combinedScore = existing.textScore + score;
      if (result.embedding) existing.embedding = result.embedding;
    } else {
      merged.set(result.id, {
        id: result.id,
        content: result.content,
        vectorScore: score,
        textScore: 0,
        combinedScore: score,
        metadata: result.metadata,
        timestamp,
        embedding: result.embedding,
      });
    }
  }

  for (const result of textResults) {
    const existing = merged.get(result.id);
    const score = result.score * textWeight;

    if (existing) {
      existing.textScore = score;
      existing.combinedScore = existing.vectorScore + score;
      if (result.embedding) existing.embedding = result.embedding;
    } else {
      merged.set(result.id, {
        id: result.id,
        content: result.content,
        vectorScore: 0,
        textScore: score,
        combinedScore: score,
        metadata: result.metadata,
        embedding: result.embedding,
      });
    }
  }

  // Sort by combined score
  let sorted = Array.from(merged.values()).sort(
    (a, b) => b.combinedScore - a.combinedScore,
  );

  // Apply MMR for diversity
  if (mmrEnabled && sorted.length > maxResults) {
    const hasEmbeddings = sorted.some((item) => item.embedding);
    const selected: typeof sorted = [sorted[0]];
    const remaining = sorted.slice(1);

    while (selected.length < maxResults && remaining.length > 0) {
      let bestMmr = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        let maxSelectedSim: number;

        if (hasEmbeddings && candidate.embedding) {
          // Use actual embedding vectors for diversity calculation
          maxSelectedSim = Math.max(
            ...selected
              .filter((s) => s.embedding)
              .map((s) =>
                similarityFn
                  ? similarityFn(candidate.embedding!, s.embedding!)
                  : cosineSimilarity(candidate.embedding!, s.embedding!),
              ),
          );
          // Fallback to 0 if no selected items have embeddings yet
          if (maxSelectedSim === -Infinity) maxSelectedSim = 0;
        } else {
          // Fallback: word overlap similarity
          maxSelectedSim = Math.max(
            ...selected.map((s) => wordOverlapSimilarity(candidate.content, s.content)),
          );
        }

        const mmr = computeMmrScore({
          querySimilarity: candidate.combinedScore,
          maxSelectedSimilarity: maxSelectedSim,
          lambda: mmrLambda,
        });

        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestIndex = i;
        }
      }

      selected.push(remaining[bestIndex]);
      remaining.splice(bestIndex, 1);
    }

    sorted = selected;
  }

  return sorted.slice(0, maxResults).map((item) => ({
    id: item.id,
    content: item.content,
    score: item.combinedScore,
    metadata: item.metadata,
    embedding: item.embedding,
  }));
}

// ─── Internal Helpers ────────────────────────────────────────────

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Fallback: word overlap similarity for MMR when embeddings unavailable.
 */
function wordOverlapSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }
  const denom = Math.sqrt(wordsA.size) * Math.sqrt(wordsB.size);
  return denom === 0 ? 0 : intersection / denom;
}
