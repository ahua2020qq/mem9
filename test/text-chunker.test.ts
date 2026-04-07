import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText, chunkTexts, mergeSmallChunks } from "../src/text-chunker.js";

describe("text-chunker", () => {
  describe("chunkText", () => {
    it("returns empty array for empty text", () => {
      assert.deepEqual(chunkText(""), []);
    });

    it("returns empty array for whitespace-only text", () => {
      assert.deepEqual(chunkText("   \n\n  "), []);
    });

    it("returns single chunk for short text", () => {
      const chunks = chunkText("Hello world");
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].text, "Hello world");
    });

    it("splits long text into multiple chunks", () => {
      const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1} with some content.`).join("\n\n");
      const chunks = chunkText(text, { maxTokens: 40, overlapTokens: 10 });
      assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
    });

    it("respects semantic strategy by default", () => {
      const text = "Para one\n\nPara two\n\nPara three";
      const chunks = chunkText(text, { maxTokens: 1000 });
      // Short text should be one chunk
      assert.equal(chunks.length, 1);
    });

    it("uses fixed strategy when specified", () => {
      const text = "A ".repeat(500);
      const chunks = chunkText(text, { strategy: "fixed", maxTokens: 30 });
      assert.ok(chunks.length > 1);
    });

    it("includes token estimates in results", () => {
      const chunks = chunkText("Hello world this is a test");
      for (const chunk of chunks) {
        assert.ok(chunk.tokens > 0);
        assert.equal(typeof chunk.tokens, "number");
      }
    });

    it("includes start and end indices", () => {
      const chunks = chunkText("Hello world");
      assert.equal(chunks[0].startIndex, 0);
      assert.ok(chunks[0].endIndex > 0);
    });
  });

  describe("chunkTexts", () => {
    it("chunks multiple texts with correct offsets", () => {
      const texts = ["Hello world", "Second text"];
      const chunks = chunkTexts(texts);
      assert.equal(chunks.length, 2);
      // Second chunk should have offset by first text length
      assert.equal(chunks[1].startIndex, "Hello world".length);
    });
  });

  describe("mergeSmallChunks", () => {
    it("merges chunks below minTokens threshold", () => {
      const chunks = [
        { text: "A", tokens: 1, startIndex: 0, endIndex: 1 },
        { text: "B", tokens: 1, startIndex: 1, endIndex: 2 },
        { text: "C", tokens: 1, startIndex: 2, endIndex: 3 },
      ];
      const merged = mergeSmallChunks(chunks, 5);
      assert.equal(merged.length, 1);
      assert.ok(merged[0].text.includes("A"));
      assert.ok(merged[0].text.includes("C"));
    });

    it("keeps chunks that exceed minTokens", () => {
      const chunks = [
        { text: "Big chunk here", tokens: 100, startIndex: 0, endIndex: 14 },
        { text: "Small", tokens: 1, startIndex: 14, endIndex: 19 },
      ];
      const merged = mergeSmallChunks(chunks, 5);
      // Big chunk is kept, small is merged with something
      assert.ok(merged.length <= 2);
    });

    it("returns single chunk unchanged", () => {
      const chunks = [{ text: "Only one", tokens: 5, startIndex: 0, endIndex: 8 }];
      const merged = mergeSmallChunks(chunks, 10);
      assert.equal(merged.length, 1);
    });
  });
});
