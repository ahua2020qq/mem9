/**
 * Memory Cache — LRU cache for embeddings and query results.
 *
 * Two-tier cache:
 *   - Embedding cache: text hash → vector (avoids redundant API calls)
 *   - Query cache: query hash → search results (avoids redundant searches)
 *
 * Both tiers share the same LRU eviction policy with configurable max entries.
 */

import { estimateTokens } from "./token-estimator.js";
import type { MemorySearchResult } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

export interface MemoryCacheOptions {
  /** Maximum cache entries across both tiers (default 500) */
  maxEntries?: number;
  /** TTL in milliseconds for cached items (default 5 minutes) */
  ttlMs?: number;
  /** Enable embedding cache (default true) */
  embeddingCacheEnabled?: boolean;
  /** Enable query result cache (default true) */
  queryCacheEnabled?: boolean;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  tokenCost: number;
}

// ─── Cache Implementation ────────────────────────────────────────

export class MemoryCache {
  private embeddingCache = new Map<string, CacheEntry<number[]>>();
  private queryCache = new Map<string, CacheEntry<MemorySearchResult[]>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  readonly embeddingEnabled: boolean;
  readonly queryEnabled: boolean;

  // Stats
  private embeddingHits = 0;
  private embeddingMisses = 0;
  private queryHits = 0;
  private queryMisses = 0;

  // Lazy TTL cleanup: track last cleanup time, run at most once per TTL period
  private lastCleanupAt = 0;

  constructor(options?: MemoryCacheOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? 500);
    this.ttlMs = Math.max(1000, options?.ttlMs ?? 5 * 60 * 1000);
    this.embeddingEnabled = options?.embeddingCacheEnabled ?? true;
    this.queryEnabled = options?.queryCacheEnabled ?? true;
  }

  // ─── Embedding Cache ──────────────────────────────────────────

  /**
   * Get a cached embedding for the given text.
   */
  getEmbedding(text: string): number[] | undefined {
    if (!this.embeddingEnabled) return undefined;
    this.lazyCleanup();

    const key = this.hashText(text);
    const entry = this.embeddingCache.get(key);
    if (!entry) {
      this.embeddingMisses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.embeddingCache.delete(key);
      this.embeddingMisses++;
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    this.embeddingHits++;
    return entry.value;
  }

  /**
   * Store an embedding in the cache.
   */
  setEmbedding(text: string, embedding: number[]): void {
    if (!this.embeddingEnabled) return;

    const key = this.hashText(text);
    this.evictIfNeeded(this.embeddingCache);

    this.embeddingCache.set(key, {
      value: embedding,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      tokenCost: estimateTokens(text),
    });
  }

  // ─── Query Cache ──────────────────────────────────────────────

  /**
   * Get cached query results.
   */
  getQueryResults(queryText: string, filterHash?: string): MemorySearchResult[] | undefined {
    if (!this.queryEnabled) return undefined;
    this.lazyCleanup();

    const key = this.hashQuery(queryText, filterHash);
    const entry = this.queryCache.get(key);
    if (!entry) {
      this.queryMisses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.queryCache.delete(key);
      this.queryMisses++;
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    this.queryHits++;
    return entry.value;
  }

  /**
   * Store query results in the cache.
   */
  setQueryResults(
    queryText: string,
    results: MemorySearchResult[],
    filterHash?: string,
  ): void {
    if (!this.queryEnabled) return;

    const key = this.hashQuery(queryText, filterHash);
    this.evictIfNeeded(this.queryCache);

    this.queryCache.set(key, {
      value: results,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      tokenCost: estimateTokens(queryText),
    });
  }

  // ─── Lazy TTL Cleanup ────────────────────────────────────────

  /**
   * Remove expired entries from both caches.
   * Called lazily — at most once per TTL period to avoid O(n) scans on every access.
   */
  private lazyCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.ttlMs) return;
    this.lastCleanupAt = now;

    for (const [key, entry] of this.embeddingCache) {
      if (this.isExpired(entry)) this.embeddingCache.delete(key);
    }
    for (const [key, entry] of this.queryCache) {
      if (this.isExpired(entry)) this.queryCache.delete(key);
    }
  }

  // ─── Invalidation ─────────────────────────────────────────────

  /**
   * Invalidate all query cache entries (e.g., after new data is stored).
   */
  invalidateQueries(): void {
    this.queryCache.clear();
  }

  /**
   * Invalidate all cache entries.
   */
  clear(): void {
    this.embeddingCache.clear();
    this.queryCache.clear();
    this.embeddingHits = 0;
    this.embeddingMisses = 0;
    this.queryHits = 0;
    this.queryMisses = 0;
  }

  // ─── Stats ────────────────────────────────────────────────────

  getStats(): {
    embeddingCacheSize: number;
    queryCacheSize: number;
    embeddingHitRate: number;
    queryHitRate: number;
  } {
    const embeddingTotal = this.embeddingHits + this.embeddingMisses;
    const queryTotal = this.queryHits + this.queryMisses;

    return {
      embeddingCacheSize: this.embeddingCache.size,
      queryCacheSize: this.queryCache.size,
      embeddingHitRate: embeddingTotal > 0 ? this.embeddingHits / embeddingTotal : 0,
      queryHitRate: queryTotal > 0 ? this.queryHits / queryTotal : 0,
    };
  }

  // ─── Internals ────────────────────────────────────────────────

  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.createdAt > this.ttlMs;
  }

  private evictIfNeeded<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size < this.maxEntries) return;

    // LRU eviction: remove oldest accessed entry
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  private hashText(text: string): string {
    // FNV-1a inspired hash with length mixing for low collision rate
    const normalized = text.toLowerCase().trim();
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = normalized.length;
    for (let i = 0; i < normalized.length; i++) {
      h1 ^= normalized.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = ((h2 << 5) - h2 + normalized.charCodeAt(i)) | 0;
    }
    return `emb_${h1.toString(36)}_${h2.toString(36)}`;
  }

  private hashQuery(queryText: string, filterHash?: string): string {
    const combined = `${queryText.toLowerCase().trim()}|${filterHash ?? ""}`;
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = combined.length;
    for (let i = 0; i < combined.length; i++) {
      h1 ^= combined.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = ((h2 << 5) - h2 + combined.charCodeAt(i)) | 0;
    }
    return `qry_${h1.toString(36)}_${h2.toString(36)}`;
  }
}
