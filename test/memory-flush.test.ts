import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
  computeContextHash,
  type MemoryFlushParams,
} from "../src/memory-flush.js";

const baseParams: MemoryFlushParams = {
  usedTokens: 0,
  contextWindowTokens: 100_000,
  softThresholdTokens: 60_000,
  hardThresholdTokens: 80_000,
  reserveTokensFloor: 10_000,
};

describe("memory-flush", () => {
  // ── shouldRunMemoryFlush ────────────────────────────────────────

  describe("shouldRunMemoryFlush", () => {
    it("returns no flush when usage is below reserveTokensFloor", () => {
      const result = shouldRunMemoryFlush({ ...baseParams, usedTokens: 5_000 });
      assert.deepEqual(result, { shouldFlush: false, isForceFlush: false });
      assert.equal(result.reason, undefined);
    });

    it("returns no flush when usage equals reserveTokensFloor minus one", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: baseParams.reserveTokensFloor - 1,
      });
      assert.equal(result.shouldFlush, false);
      assert.equal(result.isForceFlush, false);
    });

    it("returns soft flush when usage is between floor and soft threshold", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 50_000,
      });
      assert.equal(result.shouldFlush, false);
      assert.equal(result.isForceFlush, false);
    });

    it("returns soft flush when usage reaches soft threshold", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 60_000,
      });
      assert.equal(result.shouldFlush, true);
      assert.equal(result.isForceFlush, false);
      assert.ok(result.reason?.includes("soft threshold"));
    });

    it("returns soft flush when usage is between soft and hard thresholds", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 70_000,
      });
      assert.equal(result.shouldFlush, true);
      assert.equal(result.isForceFlush, false);
    });

    it("returns force flush when usage reaches hard threshold", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 80_000,
      });
      assert.equal(result.shouldFlush, true);
      assert.equal(result.isForceFlush, true);
      assert.ok(result.reason?.includes("hard threshold"));
      assert.ok(result.reason?.includes("Force compaction"));
    });

    it("returns force flush when usage exceeds hard threshold", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 95_000,
      });
      assert.equal(result.shouldFlush, true);
      assert.equal(result.isForceFlush, true);
    });

    it("includes token counts in reason string for soft flush", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 60_000,
      });
      assert.ok(result.reason?.includes("60000"));
      assert.ok(result.reason?.includes("60000"));
    });

    it("includes token counts in reason string for force flush", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 85_000,
      });
      assert.ok(result.reason?.includes("85000"));
      assert.ok(result.reason?.includes("80000"));
    });

    it("returns no flush at exactly reserveTokensFloor - 1", () => {
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 9_999,
      });
      assert.equal(result.shouldFlush, false);
    });

    it("returns no flush at exactly reserveTokensFloor since below is strict < ", () => {
      // usedTokens >= softThreshold only triggers soft flush,
      // but 10000 is below soft threshold (60000), so falls through to no-flush
      const result = shouldRunMemoryFlush({
        ...baseParams,
        usedTokens: 10_000,
      });
      assert.equal(result.shouldFlush, false);
    });
  });

  // ── shouldRunPreflightCompaction ────────────────────────────────

  describe("shouldRunPreflightCompaction", () => {
    it("returns false when usage is well below threshold", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 10_000,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, false);
    });

    it("returns false when usage is just below default 0.7 threshold", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 69_999,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, false);
    });

    it("returns true when usage reaches default 0.7 threshold", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 70_000,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, true);
    });

    it("returns true when usage exceeds default 0.7 threshold", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 85_000,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, true);
    });

    it("respects a custom threshold of 0.5", () => {
      assert.equal(
        shouldRunPreflightCompaction({
          usedTokens: 49_999,
          contextWindowTokens: 100_000,
          threshold: 0.5,
        }),
        false,
      );
      assert.equal(
        shouldRunPreflightCompaction({
          usedTokens: 50_000,
          contextWindowTokens: 100_000,
          threshold: 0.5,
        }),
        true,
      );
    });

    it("respects a custom threshold of 0.9", () => {
      assert.equal(
        shouldRunPreflightCompaction({
          usedTokens: 89_999,
          contextWindowTokens: 100_000,
          threshold: 0.9,
        }),
        false,
      );
      assert.equal(
        shouldRunPreflightCompaction({
          usedTokens: 90_000,
          contextWindowTokens: 100_000,
          threshold: 0.9,
        }),
        true,
      );
    });

    it("returns true at full context window usage", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 100_000,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, true);
    });

    it("returns true when usage exceeds context window", () => {
      const result = shouldRunPreflightCompaction({
        usedTokens: 120_000,
        contextWindowTokens: 100_000,
      });
      assert.equal(result, true);
    });
  });

  // ── computeContextHash ──────────────────────────────────────────

  describe("computeContextHash", () => {
    it("returns 'empty' for an empty message array", () => {
      assert.equal(computeContextHash([]), "empty");
    });

    it("produces consistent hashes for the same input", () => {
      const messages = [
        { content: "Hello, world!", timestamp: 1000 },
        { content: "How are you?", timestamp: 2000 },
      ];
      const hash1 = computeContextHash(messages);
      const hash2 = computeContextHash(messages);
      assert.equal(hash1, hash2);
    });

    it("produces different hashes for different content", () => {
      const messagesA = [{ content: "Alpha", timestamp: 1000 }];
      const messagesB = [{ content: "Beta", timestamp: 1000 }];
      assert.notEqual(computeContextHash(messagesA), computeContextHash(messagesB));
    });

    it("produces different hashes for different timestamps", () => {
      const messagesA = [{ content: "Same content", timestamp: 1000 }];
      const messagesB = [{ content: "Same content", timestamp: 2000 }];
      assert.notEqual(computeContextHash(messagesA), computeContextHash(messagesB));
    });

    it("produces different hashes for different message counts", () => {
      const single = [{ content: "Hello", timestamp: 1000 }];
      const doubled = [
        { content: "Hello", timestamp: 1000 },
        { content: "World", timestamp: 2000 },
      ];
      assert.notEqual(computeContextHash(single), computeContextHash(doubled));
    });

    it("uses 0 as default timestamp when timestamp is undefined", () => {
      const messages = [{ content: "No timestamp" }];
      const hash = computeContextHash(messages);
      // Hash should end with :0 since timestamp defaults to 0
      assert.ok(hash.endsWith(":0"), `Expected hash ending with :0, got ${hash}`);
    });

    it("includes message count in the hash", () => {
      const messages = [
        { content: "One", timestamp: 1000 },
        { content: "Two", timestamp: 2000 },
        { content: "Three", timestamp: 3000 },
      ];
      const hash = computeContextHash(messages);
      // Hash starts with "3:"
      assert.ok(hash.startsWith("3:"), `Expected hash starting with 3:, got ${hash}`);
    });

    it("handles messages with no content field", () => {
      const messages = [{ timestamp: 1000 }];
      const hash = computeContextHash(messages);
      assert.ok(typeof hash === "string");
      assert.ok(hash.length > 0);
    });
  });
});
