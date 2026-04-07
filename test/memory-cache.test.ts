import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryCache } from "../src/memory-cache.js";

describe("memory-cache", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache({ maxEntries: 10, ttlMs: 5000 });
  });

  describe("embedding cache", () => {
    it("returns undefined for uncached text", () => {
      assert.equal(cache.getEmbedding("uncached"), undefined);
    });

    it("stores and retrieves embeddings", () => {
      const vec = [0.1, 0.2, 0.3];
      cache.setEmbedding("test text", vec);
      assert.deepEqual(cache.getEmbedding("test text"), vec);
    });

    it("is case-insensitive for lookups", () => {
      const vec = [0.5, 0.6];
      cache.setEmbedding("Hello World", vec);
      assert.deepEqual(cache.getEmbedding("hello world"), vec);
    });

    it("tracks hit and miss stats", () => {
      cache.setEmbedding("cached", [1]);
      cache.getEmbedding("cached");   // hit
      cache.getEmbedding("cached");   // hit
      cache.getEmbedding("miss1");    // miss
      cache.getEmbedding("miss2");    // miss

      const stats = cache.getStats();
      assert.equal(stats.embeddingCacheSize, 1);
      assert.equal(stats.embeddingHitRate, 0.5); // 2 hits / 4 total
    });
  });

  describe("query cache", () => {
    it("stores and retrieves query results", () => {
      const results = [{ id: "1", content: "test", similarity: 0.9 }];
      cache.setQueryResults("search query", results);
      assert.deepEqual(cache.getQueryResults("search query"), results);
    });

    it("respects filter hash", () => {
      cache.setQueryResults("query", [{ id: "1", content: "a", similarity: 1 }], "filter1");
      assert.equal(cache.getQueryResults("query", "filter2"), undefined);
      assert.ok(cache.getQueryResults("query", "filter1"));
    });

    it("tracks query cache stats", () => {
      cache.setQueryResults("q", []);
      cache.getQueryResults("q");   // hit
      cache.getQueryResults("miss"); // miss

      const stats = cache.getStats();
      assert.equal(stats.queryCacheSize, 1);
      assert.equal(stats.queryHitRate, 0.5);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when cache is full", () => {
      const smallCache = new MemoryCache({ maxEntries: 3, ttlMs: 60000 });

      for (let i = 0; i < 5; i++) {
        smallCache.setEmbedding(`text ${i}`, [i]);
      }

      const stats = smallCache.getStats();
      assert.equal(stats.embeddingCacheSize, 3);

      // First 2 entries should be evicted
      assert.equal(smallCache.getEmbedding("text 0"), undefined);
      assert.equal(smallCache.getEmbedding("text 1"), undefined);
      // Later entries should still be there
      assert.deepEqual(smallCache.getEmbedding("text 4"), [4]);
    });
  });

  describe("TTL expiration", () => {
    it("expires entries after TTL", async () => {
      // TTL is clamped to min 1000ms, so use 1000 and wait 1500ms
      const shortCache = new MemoryCache({ maxEntries: 100, ttlMs: 1000 });
      const text = "this_is_a_unique_ttl_test_string";
      shortCache.setEmbedding(text, [1]);

      // Should be available immediately
      assert.deepEqual(shortCache.getEmbedding(text), [1]);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Should be expired
      assert.equal(shortCache.getEmbedding(text), undefined);
    });
  });

  describe("invalidation", () => {
    it("invalidateQueries clears query cache only", () => {
      cache.setEmbedding("text", [1]);
      cache.setQueryResults("query", []);

      cache.invalidateQueries();

      assert.ok(cache.getEmbedding("text")); // still there
      assert.equal(cache.getQueryResults("query"), undefined); // gone
    });

    it("clear resets everything", () => {
      cache.setEmbedding("text", [1]);
      cache.setQueryResults("query", []);
      cache.clear();

      assert.equal(cache.getEmbedding("text"), undefined);
      assert.equal(cache.getQueryResults("query"), undefined);

      const stats = cache.getStats();
      assert.equal(stats.embeddingHitRate, 0);
      assert.equal(stats.queryHitRate, 0);
    });
  });

  describe("disabled caches", () => {
    it("does not cache embeddings when disabled", () => {
      const noEmbCache = new MemoryCache({ embeddingCacheEnabled: false });
      noEmbCache.setEmbedding("text", [1]);
      assert.equal(noEmbCache.getEmbedding("text"), undefined);
    });

    it("does not cache queries when disabled", () => {
      const noQryCache = new MemoryCache({ queryCacheEnabled: false });
      noQryCache.setQueryResults("q", []);
      assert.equal(noQryCache.getQueryResults("q"), undefined);
    });
  });
});
