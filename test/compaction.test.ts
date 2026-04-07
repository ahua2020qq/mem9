import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  pruneHistoryForContextShare,
  summarizeInStages,
  summarizeWithFallback,
  resolveContextWindowTokens,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "../src/compaction.js";
import type { SummarizeFunction } from "../src/compaction.js";

// Mock summarizer that returns a fixed summary
const mockSummarizer: SummarizeFunction = async (messages, opts) => {
  const total = messages.map((m) =>
    typeof (m as { content?: unknown }).content === "string"
      ? ((m as { content: string }).content)
      : "[complex]",
  ).join(" ");
  return `Summary of ${messages.length} messages: ${total.slice(0, 100)}`;
};

describe("compaction", () => {
  describe("computeAdaptiveChunkRatio", () => {
    it("returns base ratio for small messages", () => {
      const msgs = Array.from({ length: 10 }, () => ({
        role: "user" as const,
        content: "short",
      }));
      assert.equal(computeAdaptiveChunkRatio(msgs, 200000), BASE_CHUNK_RATIO);
    });

    it("reduces ratio for large messages", () => {
      // avgTokens with SAFETY_MARGIN(1.2): 12500*1.2=15000, avgRatio=15000/10000=1.5 > 0.1
      // reduction = min(1.5*2, 0.25) = 0.25, ratio = max(0.15, 0.4-0.25) = 0.15
      const msgs = [{ role: "user" as const, content: "x".repeat(50000) }];
      const ratio = computeAdaptiveChunkRatio(msgs, 10000);
      assert.ok(ratio < BASE_CHUNK_RATIO);
      assert.ok(ratio >= MIN_CHUNK_RATIO);
    });

    it("returns base ratio for empty messages", () => {
      assert.equal(computeAdaptiveChunkRatio([], 200000), BASE_CHUNK_RATIO);
    });

    it("never goes below MIN_CHUNK_RATIO", () => {
      // Extremely large message
      const msgs = [{ role: "user" as const, content: "x".repeat(500000) }];
      const ratio = computeAdaptiveChunkRatio(msgs, 1000);
      assert.ok(ratio >= MIN_CHUNK_RATIO);
    });
  });

  describe("isOversizedForSummary", () => {
    it("returns false for small messages", () => {
      assert.ok(!isOversizedForSummary({ role: "user", content: "hello" }, 200000));
    });

    it("returns true for messages > 50% of context", () => {
      // 50000 chars ≈ 12500 tokens, > 50% of 20000
      assert.ok(isOversizedForSummary({ role: "user", content: "x".repeat(50000) }, 20000));
    });
  });

  describe("splitMessagesByTokenShare", () => {
    it("returns empty for empty messages", () => {
      assert.deepEqual(splitMessagesByTokenShare([]), []);
    });

    it("returns single chunk for few messages", () => {
      const msgs = [{ role: "user", content: "hello" }];
      const result = splitMessagesByTokenShare(msgs, 4);
      assert.equal(result.length, 1);
    });

    it("splits into requested parts", () => {
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i} with enough text to split properly`,
      }));
      const result = splitMessagesByTokenShare(msgs, 3);
      assert.equal(result.length, 3);
    });
  });

  describe("chunkMessagesByMaxTokens", () => {
    it("returns empty for empty messages", () => {
      assert.deepEqual(chunkMessagesByMaxTokens([], 1000), []);
    });

    it("keeps all messages when under limit", () => {
      const msgs = [
        { role: "user", content: "short" },
        { role: "assistant", content: "reply" },
      ];
      const chunks = chunkMessagesByMaxTokens(msgs, 10000);
      assert.equal(chunks.length, 1);
    });

    it("splits when messages exceed token limit", () => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}: ${"x".repeat(200)}`,
      }));
      const chunks = chunkMessagesByMaxTokens(msgs, 100);
      assert.ok(chunks.length > 1);
    });
  });

  describe("pruneHistoryForContextShare", () => {
    it("keeps all messages when under budget", () => {
      const msgs = [{ role: "user", content: "hello" }];
      const result = pruneHistoryForContextShare({
        messages: msgs,
        maxContextTokens: 10000,
      });
      assert.equal(result.messages.length, 1);
      assert.equal(result.droppedMessages, 0);
    });

    it("drops oldest chunks when over budget", () => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `Message number ${i}: ${"content ".repeat(50)}`,
      }));
      const result = pruneHistoryForContextShare({
        messages: msgs,
        maxContextTokens: 500,
        maxHistoryShare: 0.5,
      });
      assert.ok(result.droppedMessages > 0);
      assert.ok(result.messages.length < msgs.length);
    });
  });

  describe("summarizeInStages", () => {
    it("returns fallback for empty messages", async () => {
      const result = await summarizeInStages({
        messages: [],
        summarize: mockSummarizer,
        contextWindow: 200000,
        reserveTokens: 1024,
      });
      assert.equal(result, "No prior history.");
    });

    it("summarizes small messages directly", async () => {
      const msgs = [{ role: "user", content: "Hello" }];
      const result = await summarizeInStages({
        messages: msgs,
        summarize: mockSummarizer,
        contextWindow: 200000,
        reserveTokens: 1024,
      });
      assert.ok(result.includes("Summary of 1"));
    });

    it("passes previousSummary to summarizer", async () => {
      const msgs = [{ role: "user", content: "New message" }];
      const result = await summarizeInStages({
        messages: msgs,
        summarize: async (m, opts) => {
          return opts.previousSummary ? `${opts.previousSummary} + new` : "fresh";
        },
        contextWindow: 200000,
        reserveTokens: 1024,
        previousSummary: "old summary",
      });
      assert.ok(result.includes("old summary"));
    });
  });

  describe("resolveContextWindowTokens", () => {
    it("returns provided value", () => {
      assert.equal(resolveContextWindowTokens(100000), 100000);
    });

    it("returns fallback when undefined", () => {
      assert.equal(resolveContextWindowTokens(undefined, 200000), 200000);
    });

    it("clamps to minimum 1", () => {
      assert.equal(resolveContextWindowTokens(0), 1);
    });
  });
});
