import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory-store.js";

describe("memory-store", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  describe("store", () => {
    it("stores an entry and returns an ID", async () => {
      const id = await store.store({ content: "Hello world" });
      assert.ok(id.startsWith("mem_"));
    });

    it("stores and retrieves entry by ID", async () => {
      const id = await store.store({ content: "Test content" });
      const entry = store.get(id);
      assert.ok(entry);
      assert.equal(entry.content, "Test content");
    });

    it("stores metadata with entry", async () => {
      const id = await store.store({
        content: "Tagged entry",
        metadata: { source: "test", tags: ["unit"], timestamp: 1000 },
      });
      const entry = store.get(id);
      assert.equal(entry?.metadata?.source, "test");
      assert.deepEqual(entry?.metadata?.tags, ["unit"]);
    });

    it("auto-chunks long documents when chunkThreshold is set", async () => {
      const chunkStore = new MemoryStore({ chunkThreshold: 20 });
      // Each paragraph is ~5 tokens, 30 paragraphs = ~150 tokens > 20 threshold
      const longText = Array.from({ length: 30 }, (_, i) =>
        `Paragraph number ${i + 1} with enough words to make a substantial chunk that exceeds thresholds`,
      ).join("\n\n");
      const id = await chunkStore.store({ content: longText });

      // Should return a parent doc ID
      assert.ok(id.startsWith("doc_"));

      // Stats should show individual chunk entries
      const stats = chunkStore.getStats();
      assert.ok(stats.totalEntries > 1, `Expected >1 entries, got ${stats.totalEntries}`);
      assert.equal(stats.parentDocs, 1);
    });

    it("stores short docs as single entry", async () => {
      const store10 = new MemoryStore({ chunkThreshold: 500 });
      const id = await store10.store({ content: "Short" });
      assert.ok(id.startsWith("mem_"));
      assert.equal(store10.getStats().totalEntries, 1);
    });
  });

  describe("storeBatch", () => {
    it("stores multiple entries", async () => {
      const ids = await store.storeBatch([
        { content: "First" },
        { content: "Second" },
        { content: "Third" },
      ]);
      assert.equal(ids.length, 3);
      assert.equal(store.getStats().totalEntries, 3);
    });
  });

  describe("search", () => {
    it("finds entries by full-text search", async () => {
      await store.store({ content: "The quick brown fox jumps" });
      await store.store({ content: "A lazy dog sleeps" });
      await store.store({ content: "The fox and the dog are friends" });

      const results = await store.search({ text: "fox", strategy: "fulltext" });
      assert.ok(results.length >= 1);
      assert.ok(results.some((r) => r.content.includes("fox")));
    });

    it("returns empty results for no matches", async () => {
      await store.store({ content: "Hello world" });
      const results = await store.search({ text: "xyznonexistent", strategy: "fulltext" });
      assert.equal(results.length, 0);
    });

    it("respects topK limit", async () => {
      for (let i = 0; i < 10; i++) {
        await store.store({ content: `Document about testing ${i}` });
      }
      const results = await store.search({ text: "testing", strategy: "fulltext", topK: 3 });
      assert.ok(results.length <= 3);
    });

    it("respects minSimilarity threshold", async () => {
      await store.store({ content: "alpha beta gamma" });
      const results = await store.search({
        text: "completely different keywords zzz",
        strategy: "fulltext",
        minSimilarity: 0.99,
      });
      // Should have no results at very high threshold
      assert.equal(results.length, 0);
    });

    it("applies source filter", async () => {
      await store.store({ content: "test content", metadata: { source: "chat" } });
      await store.store({ content: "test content", metadata: { source: "file" } });

      const results = await store.search({
        text: "test",
        strategy: "fulltext",
        filter: { source: "chat" },
      });
      assert.ok(results.every((r) => r.metadata?.source === "chat"));
    });

    it("applies tag filter", async () => {
      await store.store({ content: "tagged content", metadata: { tags: ["important"] } });
      await store.store({ content: "tagged content", metadata: { tags: ["minor"] } });

      const results = await store.search({
        text: "tagged",
        strategy: "fulltext",
        filter: { tags: ["important"] },
      });
      assert.ok(results.some((r) => r.metadata?.tags?.includes("important")));
    });

    it("caches query results", async () => {
      await store.store({ content: "cacheable content about caching" });

      // First search
      const r1 = await store.search({ text: "caching", strategy: "fulltext" });
      // Second search (should hit cache)
      const r2 = await store.search({ text: "caching", strategy: "fulltext" });
      assert.deepEqual(r1.map((r) => r.id), r2.map((r) => r.id));

      // Check cache stats
      const stats = store.getStats();
      assert.ok(stats.queryCacheSize > 0);
    });
  });

  describe("delete", () => {
    it("deletes a single entry", async () => {
      const id = await store.store({ content: "To delete" });
      assert.ok(store.delete(id));
      assert.equal(store.get(id), undefined);
    });

    it("returns false for non-existent ID", () => {
      assert.ok(!store.delete("nonexistent"));
    });

    it("deletes all chunks when parent doc ID is given", async () => {
      const chunkStore = new MemoryStore({ chunkThreshold: 20 });
      const longText = Array.from({ length: 30 }, (_, i) =>
        `Paragraph ${i + 1} content with enough text to be split properly by the chunker`,
      ).join("\n\n");
      const parentId = await chunkStore.store({ content: longText });

      const statsBefore = chunkStore.getStats();
      assert.ok(statsBefore.totalEntries > 1, `Expected >1 entries before delete, got ${statsBefore.totalEntries}`);

      chunkStore.delete(parentId);

      const statsAfter = chunkStore.getStats();
      assert.equal(statsAfter.totalEntries, 0);
      assert.equal(statsAfter.parentDocs, 0);
    });
  });

  describe("clear", () => {
    it("clears all entries and resets stats", async () => {
      await store.store({ content: "Entry 1" });
      await store.store({ content: "Entry 2" });
      store.clear();
      assert.equal(store.getStats().totalEntries, 0);
    });
  });

  describe("getStats", () => {
    it("reports correct entry count", async () => {
      await store.store({ content: "A" });
      await store.store({ content: "B" });
      assert.equal(store.getStats().totalEntries, 2);
    });
  });
});
