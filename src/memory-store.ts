/**
 * In-Memory Memory Store
 *
 * A complete implementation of the MemoryStore pattern with:
 *   - Vector search (cosine similarity)
 *   - Full-text search (keyword matching)
 *   - Hybrid retrieval (weighted merge + optional MMR)
 *   - Embedding integration (auto-generate if not provided)
 *
 * Zero external dependencies. For production use, replace with
 * SQLite + vector extension for persistence.
 */

import type { MemoryEntry, MemoryQuery, MemorySearchResult } from "./types.js";
import { cosineSimilarity, type EmbeddingProvider } from "./embedding-provider.js";
import { estimateTokens } from "./token-estimator.js";
import { chunkText, type ChunkingOptions } from "./text-chunker.js";
import { MemoryCache, type MemoryCacheOptions } from "./memory-cache.js";
import { ValidationError } from "./errors.js";

// ─── Types ───────────────────────────────────────────────────────

export interface MemoryStoreOptions {
  /** Embedding provider for auto-generating vectors */
  embeddingProvider?: EmbeddingProvider;
  /** Default topK for searches (default 6) */
  defaultTopK?: number;
  /** Default minimum similarity score (default 0.35) */
  defaultMinScore?: number;
  /** Auto-chunk threshold in tokens (default 500). Set to 0 to disable. */
  chunkThreshold?: number;
  /** Chunking options passed to TextChunker when auto-chunking */
  chunkingOptions?: ChunkingOptions;
  /** Cache configuration */
  cacheOptions?: MemoryCacheOptions;
  /** Maximum number of entries in the store (default 50_000). Evicts oldest when exceeded. */
  maxEntries?: number;
}

interface StoredEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata?: MemoryEntry["metadata"];
  createdAt: number;
  /** Parent document ID when auto-chunked */
  parentDocId?: string;
}

// ─── Memory Store Class ──────────────────────────────────────────

export class MemoryStore {
  private entries = new Map<string, StoredEntry>();
  private nextId = 1;
  private readonly provider?: EmbeddingProvider;
  private readonly defaultTopK: number;
  private readonly defaultMinScore: number;
  private readonly chunkThreshold: number;
  private readonly chunkingOptions?: ChunkingOptions;
  private readonly maxEntries: number;
  readonly cache: MemoryCache;

  // Write serializer: ensures sequential writes for embedding cache consistency
  private writeLock: Promise<void> = Promise.resolve();

  // Full-text index: keyword → Set of entry IDs
  private ftsIndex = new Map<string, Set<string>>();

  // BM25 stats: doc ID → token count, plus global doc count
  private docLengths = new Map<string, number>();
  private totalDocCount = 0;
  private avgDocLength = 0;

  // BM25 parameters
  private static readonly BM25_K1 = 1.2;
  private static readonly BM25_B = 0.75;

  // Parent doc → child chunk IDs for bulk delete
  private parentIndex = new Map<string, string[]>();

  constructor(options?: MemoryStoreOptions) {
    this.provider = options?.embeddingProvider;
    this.defaultTopK = options?.defaultTopK ?? 6;
    this.defaultMinScore = options?.defaultMinScore ?? 0.35;
    this.chunkThreshold = options?.chunkThreshold ?? 500;
    this.chunkingOptions = options?.chunkingOptions;
    this.maxEntries = options?.maxEntries ?? 50_000;
    this.cache = new MemoryCache(options?.cacheOptions);
  }

  // ─── Write ────────────────────────────────────────────────────

  /**
   * Store a memory entry. Auto-generates embedding if not provided.
   * If content exceeds chunkThreshold tokens, auto-chunks into sub-entries.
   * Returns the primary ID (or parent doc ID when chunked).
   *
   * Writes are serialized to prevent race conditions on the embedding cache.
   */
  async store(entry: MemoryEntry, signal?: AbortSignal): Promise<string> {
    // Validate outside lock — cheap and can fail fast
    if (!entry?.content || typeof entry.content !== "string" || !entry.content.trim()) {
      throw new ValidationError("MemoryEntry.content must be a non-empty string", "content");
    }
    if (entry.content.length > 1_000_000) {
      throw new ValidationError("MemoryEntry.content exceeds 1MB limit", "content");
    }
    if (entry.embedding && !Array.isArray(entry.embedding)) {
      throw new ValidationError("MemoryEntry.embedding must be a number array", "embedding");
    }

    // Serialize writes to prevent embedding cache race conditions
    const prevLock = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => { resolve = r; });
    try {
      await prevLock;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const tokenCount = estimateTokens(entry.content);

      // Auto-chunk if content exceeds threshold
      if (this.chunkThreshold > 0 && tokenCount > this.chunkThreshold) {
        return await this.storeChunked(entry, signal);
      }

      return await this.storeSingle(entry, undefined, signal);
    } finally {
      resolve();
    }
  }

  /**
   * Store a single (non-chunked) entry.
   */
  private async storeSingle(entry: MemoryEntry, parentDocId?: string, signal?: AbortSignal): Promise<string> {
    const id = `mem_${this.nextId++}`;

    let embedding = entry.embedding;
    if (embedding && embedding.some((v) => !Number.isFinite(v))) {
      throw new ValidationError("Embedding vector contains NaN or Infinity", "embedding");
    }
    if (!embedding && this.provider) {
      // Check cache first
      embedding = this.cache.getEmbedding(entry.content);
      if (!embedding) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        embedding = await this.provider.embedQuery(entry.content);
        this.cache.setEmbedding(entry.content, embedding);
      }
    }

    const stored: StoredEntry = {
      id,
      content: entry.content,
      embedding,
      metadata: entry.metadata,
      createdAt: entry.metadata?.timestamp ?? Date.now(),
      parentDocId,
    };

    this.entries.set(id, stored);
    this.updateFTSIndex(id, entry.content);
    this.cache.invalidateQueries();
    this.evictIfNeeded();

    return id;
  }

  /**
   * Auto-chunk a large entry and store each chunk as a sub-entry.
   * Returns a parent doc ID that can be used for bulk delete.
   */
  private async storeChunked(entry: MemoryEntry, signal?: AbortSignal): Promise<string> {
    const parentId = `doc_${this.nextId++}`;
    const chunks = chunkText(entry.content, this.chunkingOptions);
    const childIds: string[] = [];

    // Batch-embed all chunks
    let embeddings: number[][] | undefined;
    if (!entry.embedding && this.provider) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const texts = chunks.map((c) => c.text);
      embeddings = await this.provider.embedBatch(texts);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkEntry: MemoryEntry = {
        content: chunk.text,
        metadata: {
          ...entry.metadata,
          chunkIndex: i,
          totalChunks: chunks.length,
        },
        embedding: entry.embedding ? undefined : embeddings?.[i],
      };

      const childId = await this.storeSingle(chunkEntry, parentId, signal);
      childIds.push(childId);
    }

    this.parentIndex.set(parentId, childIds);
    return parentId;
  }

  /**
   * Store multiple entries in batch.
   */
  async storeBatch(entries: MemoryEntry[], signal?: AbortSignal): Promise<string[]> {
    // Batch embed if provider supports it
    const needsEmbedding: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].embedding && this.provider) {
        needsEmbedding.push(i);
      }
    }

    if (needsEmbedding.length > 0 && this.provider) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const texts = needsEmbedding.map((i) => entries[i].content);
      const embeddings = await this.provider.embedBatch(texts);
      for (let j = 0; j < needsEmbedding.length; j++) {
        entries[needsEmbedding[j]].embedding = embeddings[j];
      }
    }

    return Promise.all(entries.map((entry) => this.store(entry, signal)));
  }

  // ─── Search ───────────────────────────────────────────────────

  /**
   * Search memories with configurable strategy.
   */
  async search(query: MemoryQuery, signal?: AbortSignal): Promise<MemorySearchResult[]> {
    if (!query?.text || typeof query.text !== "string" || !query.text.trim()) {
      throw new ValidationError("MemoryQuery.text must be a non-empty string", "text");
    }

    const topK = query.topK ?? this.defaultTopK;
    const minScore = query.minSimilarity ?? this.defaultMinScore;
    const strategy = query.strategy ?? "hybrid";

    // Check query cache
    const filterHash = this.hashFilter(query.filter);
    const cached = this.cache.getQueryResults(query.text, filterHash);
    if (cached) return cached.slice(0, topK);

    // Apply time filter
    let candidates = this.filterEntries(query.filter);

    let results: MemorySearchResult[];

    if (strategy === "vector" || strategy === "hybrid") {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const vectorResults = await this.vectorSearch(query.text, candidates, topK * 4);
      if (strategy === "vector") {
        results = vectorResults
          .filter((r) => r.similarity >= minScore)
          .slice(0, topK);
      } else {
        // Hybrid: merge vector + text results
        const textResults = this.fullTextSearch(query.text, candidates, topK * 4);
        results = this.mergeResults(vectorResults, textResults, topK, minScore);
      }
    } else {
      // Full-text only
      const textResults = this.fullTextSearch(query.text, candidates, topK * 4);
      results = textResults
        .filter((r) => r.similarity >= minScore)
        .slice(0, topK);
    }

    // Cache the results
    this.cache.setQueryResults(query.text, results, filterHash);
    return results;
  }

  // ─── Management ───────────────────────────────────────────────

  /**
   * Delete an entry by ID. If the ID is a parent doc ID, deletes all child chunks.
   * If the ID is a chunk, deletes just that chunk.
   */
  delete(id: string): boolean {
    // Check if it's a parent doc ID → delete all children
    const children = this.parentIndex.get(id);
    if (children) {
      for (const childId of children) {
        const child = this.entries.get(childId);
        if (child) {
          this.removeFromFTSIndex(childId, child.content);
          this.entries.delete(childId);
        }
      }
      this.parentIndex.delete(id);
      return true;
    }

    // Single entry delete
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.removeFromFTSIndex(id, entry.content);
    this.entries.delete(id);

    // If this was a chunk, remove from parent's child list
    if (entry.parentDocId) {
      const siblings = this.parentIndex.get(entry.parentDocId);
      if (siblings) {
        const idx = siblings.indexOf(id);
        if (idx >= 0) siblings.splice(idx, 1);
        if (siblings.length === 0) this.parentIndex.delete(entry.parentDocId);
      }
    }

    return true;
  }

  /**
   * Get store statistics.
   */
  getStats(): {
    totalEntries: number;
    parentDocs: number;
    embeddingCacheSize: number;
    queryCacheSize: number;
    embeddingHitRate: number;
    queryHitRate: number;
  } {
    const cacheStats = this.cache.getStats();
    return {
      totalEntries: this.entries.size,
      parentDocs: this.parentIndex.size,
      embeddingCacheSize: cacheStats.embeddingCacheSize,
      queryCacheSize: cacheStats.queryCacheSize,
      embeddingHitRate: cacheStats.embeddingHitRate,
      queryHitRate: cacheStats.queryHitRate,
    };
  }

  /**
   * Get an entry by ID.
   */
  get(id: string): StoredEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
    this.ftsIndex.clear();
    this.parentIndex.clear();
    this.docLengths.clear();
    this.totalDocCount = 0;
    this.avgDocLength = 0;
    this.cache.clear();
    this.nextId = 1;
  }

  // ─── Vector Search ────────────────────────────────────────────

  /**
   * Evict oldest entries when the store exceeds maxEntries.
   */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;

    // Find and remove oldest 10% (amortized O(1) per insert)
    const toEvict = Math.max(1, Math.floor(this.maxEntries * 0.1));
    const sorted = Array.from(this.entries.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (let i = 0; i < toEvict && i < sorted.length; i++) {
      this.delete(sorted[i][0]);
    }
  }
  private async vectorSearch(
    queryText: string,
    candidates: StoredEntry[],
    limit: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.provider) {
      // No embedding provider — can only search entries with pre-computed embeddings
      return [];
    }

    // Check embedding cache for query
    let queryEmbedding = this.cache.getEmbedding(queryText);
    if (!queryEmbedding) {
      queryEmbedding = await this.provider.embedQuery(queryText);
      this.cache.setEmbedding(queryText, queryEmbedding);
    }

    const scored: MemorySearchResult[] = [];
    for (const entry of candidates) {
      if (!entry.embedding) continue;

      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      scored.push({
        id: entry.id,
        content: entry.content,
        similarity,
        metadata: entry.metadata,
      });
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ─── Full-Text Search ─────────────────────────────────────────

  private fullTextSearch(
    queryText: string,
    candidates: StoredEntry[],
    limit: number,
  ): MemorySearchResult[] {
    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) return [];

    const candidateIds = new Set(candidates.map((e) => e.id));

    // Deduplicate query tokens for IDF computation
    const uniqueQueryTokens = [...new Set(queryTokens)];
    if (this.totalDocCount === 0 || this.avgDocLength === 0) return [];

    // Compute BM25 score per candidate
    const scores = new Map<string, number>();

    for (const token of uniqueQueryTokens) {
      const matchingIds = this.ftsIndex.get(token);
      if (!matchingIds) continue;

      // IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
      const df = matchingIds.size;
      const idf = Math.log((this.totalDocCount - df + 0.5) / (df + 0.5) + 1);

      for (const id of matchingIds) {
        if (!candidateIds.has(id)) continue;

        const entry = this.entries.get(id);
        if (!entry) continue;

        // TF = count of token in document
        const docTokens = this.tokenize(entry.content);
        const tf = docTokens.filter((t) => t === token).length;
        const docLen = this.docLengths.get(id) ?? docTokens.length;

        // BM25 score: IDF × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × dl/avgdl))
        const { BM25_K1: k1, BM25_B: b } = MemoryStore;
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / this.avgDocLength));
        const score = idf * tfNorm;

        if (score > 0) {
          scores.set(id, (scores.get(id) ?? 0) + score);
        }
      }
    }

    // Normalize to 0-1 range
    const scoreValues = [...scores.values()];
    const maxScore = scoreValues.length > 0 ? Math.max(...scoreValues) : 1;

    const scored: MemorySearchResult[] = [];
    for (const [id, rawScore] of scores) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      scored.push({
        id,
        content: entry.content,
        similarity: rawScore / maxScore,
        metadata: entry.metadata,
      });
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ─── Hybrid Merge ─────────────────────────────────────────────

  private mergeResults(
    vectorResults: MemorySearchResult[],
    textResults: MemorySearchResult[],
    topK: number,
    minScore: number,
  ): MemorySearchResult[] {
    const VECTOR_WEIGHT = 0.7;
    const TEXT_WEIGHT = 0.3;

    const merged = new Map<string, MemorySearchResult>();

    for (const r of vectorResults) {
      merged.set(r.id, {
        ...r,
        similarity: r.similarity * VECTOR_WEIGHT,
      });
    }

    for (const r of textResults) {
      const existing = merged.get(r.id);
      if (existing) {
        existing.similarity += r.similarity * TEXT_WEIGHT;
      } else {
        merged.set(r.id, {
          ...r,
          similarity: r.similarity * TEXT_WEIGHT,
        });
      }
    }

    return Array.from(merged.values())
      .filter((r) => r.similarity >= minScore)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  // ─── FTS Index ────────────────────────────────────────────────

  private updateFTSIndex(id: string, content: string): void {
    const tokens = this.tokenize(content);
    for (const token of tokens) {
      let set = this.ftsIndex.get(token);
      if (!set) {
        set = new Set();
        this.ftsIndex.set(token, set);
      }
      set.add(id);
    }

    // BM25 stats
    this.docLengths.set(id, tokens.length);
    this.totalDocCount++;
    this.avgDocLength = this.computeAvgDocLength();
  }

  private removeFromFTSIndex(id: string, content: string): void {
    const tokens = this.tokenize(content);
    for (const token of tokens) {
      this.ftsIndex.get(token)?.delete(id);
    }

    // BM25 stats
    this.docLengths.delete(id);
    this.totalDocCount = Math.max(0, this.totalDocCount - 1);
    this.avgDocLength = this.computeAvgDocLength();
  }

  private computeAvgDocLength(): number {
    if (this.totalDocCount === 0) return 0;
    let total = 0;
    for (const len of this.docLengths.values()) total += len;
    return total / this.totalDocCount;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private filterEntries(
    filter?: MemoryQuery["filter"],
  ): StoredEntry[] {
    let entries = Array.from(this.entries.values());

    if (!filter) return entries;

    if (filter.source) {
      entries = entries.filter((e) => e.metadata?.source === filter.source);
    }
    if (filter.tags && filter.tags.length > 0) {
      entries = entries.filter((e) =>
        filter.tags!.some((tag) => e.metadata?.tags?.includes(tag)),
      );
    }
    if (filter.since) {
      entries = entries.filter((e) => (e.metadata?.timestamp ?? e.createdAt) >= filter.since!);
    }

    return entries;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1);
  }

  private hashFilter(filter?: MemoryQuery["filter"]): string {
    if (!filter) return "";
    return `${filter.source ?? ""}|${filter.tags?.join(",") ?? ""}|${filter.since ?? ""}`;
  }
}
