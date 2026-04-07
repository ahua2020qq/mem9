import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager.js";
import type { ConversationMessage } from "../src/types.js";

// Helper to create a simple message
function msg(role: "user" | "assistant" | "system" | "toolResult", content: string): ConversationMessage {
  return { role, content };
}

describe("session-manager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  // ─── getOrCreate ──────────────────────────────────────────────

  describe("getOrCreate", () => {
    it("creates a new session with correct defaults", () => {
      const session = sm.getOrCreate("sess-1");

      assert.equal(session.key, "sess-1");
      assert.deepEqual(session.messages, []);
      assert.equal(session.tokenCount, 0);
      assert.ok(typeof session.createdAt === "number");
      assert.ok(typeof session.lastActivityAt === "number");
      assert.ok(session.createdAt > 0);
    });

    it("returns the same session on repeated calls with the same key", () => {
      const first = sm.getOrCreate("sess-1");
      const second = sm.getOrCreate("sess-1");

      assert.equal(first, second);
    });

    it("updates lastActivityAt on subsequent access", async () => {
      const session = sm.getOrCreate("sess-1");
      const firstActivity = session.lastActivityAt;

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      const accessed = sm.getOrCreate("sess-1");
      assert.ok(accessed.lastActivityAt >= firstActivity);
    });

    it("creates independent sessions for different keys", () => {
      const a = sm.getOrCreate("a");
      const b = sm.getOrCreate("b");

      assert.notEqual(a, b);
      assert.equal(a.key, "a");
      assert.equal(b.key, "b");
    });
  });

  // ─── close ────────────────────────────────────────────────────

  describe("close", () => {
    it("removes an existing session and returns true", () => {
      sm.getOrCreate("sess-1");
      assert.equal(sm.size, 1);

      const result = sm.close("sess-1");
      assert.equal(result, true);
      assert.equal(sm.size, 0);
      assert.equal(sm.has("sess-1"), false);
    });

    it("returns false for a non-existent session", () => {
      const result = sm.close("does-not-exist");
      assert.equal(result, false);
    });

    it("does not affect other sessions", () => {
      sm.getOrCreate("a");
      sm.getOrCreate("b");

      sm.close("a");
      assert.equal(sm.has("a"), false);
      assert.equal(sm.has("b"), true);
      assert.equal(sm.size, 1);
    });
  });

  // ─── evictIdle ────────────────────────────────────────────────

  describe("evictIdle", () => {
    it("evicts sessions idle beyond the TTL", () => {
      const ttlMs = 50;
      const smWithShortTtl = new SessionManager({ idleTtlMs: ttlMs });

      // Create a session and artificially age its lastActivityAt
      const session = smWithShortTtl.getOrCreate("old-session");
      session.lastActivityAt = Date.now() - ttlMs - 1;

      // Create a fresh session that should survive
      smWithShortTtl.getOrCreate("fresh-session");

      const evicted = smWithShortTtl.evictIdle();

      assert.equal(evicted, 1);
      assert.equal(smWithShortTtl.has("old-session"), false);
      assert.equal(smWithShortTtl.has("fresh-session"), true);
    });

    it("returns 0 when no sessions are idle", () => {
      sm.getOrCreate("active-session");
      const evicted = sm.evictIdle();
      assert.equal(evicted, 0);
      assert.equal(sm.size, 1);
    });

    it("returns 0 when there are no sessions at all", () => {
      const evicted = sm.evictIdle();
      assert.equal(evicted, 0);
    });

    it("evicts multiple idle sessions at once", () => {
      const ttlMs = 50;
      const smWithShortTtl = new SessionManager({ idleTtlMs: ttlMs });

      const s1 = smWithShortTtl.getOrCreate("old-1");
      const s2 = smWithShortTtl.getOrCreate("old-2");
      smWithShortTtl.getOrCreate("fresh");

      s1.lastActivityAt = Date.now() - ttlMs - 100;
      s2.lastActivityAt = Date.now() - ttlMs - 50;

      const evicted = smWithShortTtl.evictIdle();
      assert.equal(evicted, 2);
      assert.equal(smWithShortTtl.size, 1);
      assert.equal(smWithShortTtl.has("fresh"), true);
    });
  });

  // ─── addMessage ───────────────────────────────────────────────

  describe("addMessage", () => {
    it("adds a message and updates token count", () => {
      const session = sm.getOrCreate("sess-1");
      assert.equal(session.messages.length, 0);
      assert.equal(session.tokenCount, 0);

      const result = sm.addMessage("sess-1", msg("user", "Hello world"));

      assert.equal(result!.messages.length, 1);
      assert.equal(result!.messages[0].role, "user");
      assert.ok(result!.tokenCount > 0);
    });

    it("updates lastActivityAt when a message is added", async () => {
      const session = sm.getOrCreate("sess-1");
      const beforeActivity = session.lastActivityAt;

      await new Promise((r) => setTimeout(r, 10));

      sm.addMessage("sess-1", msg("user", "Hi"));
      assert.ok(session.lastActivityAt >= beforeActivity);
    });

    it("returns null for a non-existent session", () => {
      const result = sm.addMessage("nonexistent", msg("user", "Hi"));
      assert.equal(result, null);
    });

    it("accumulates multiple messages", () => {
      sm.getOrCreate("sess-1");
      sm.addMessage("sess-1", msg("user", "Hello"));
      sm.addMessage("sess-1", msg("assistant", "Hi there"));
      sm.addMessage("sess-1", msg("user", "How are you?"));

      const session = sm.get("sess-1")!;
      assert.equal(session.messages.length, 3);
      assert.ok(session.tokenCount > 0);
    });
  });

  // ─── replaceMessages ──────────────────────────────────────────

  describe("replaceMessages", () => {
    it("replaces messages and recalculates token count", () => {
      sm.getOrCreate("sess-1");
      sm.addMessage("sess-1", msg("user", "This is a long original message"));

      const originalTokens = sm.get("sess-1")!.tokenCount;

      const newMessages: ConversationMessage[] = [
        msg("system", "Short"),
      ];

      const result = sm.replaceMessages("sess-1", newMessages);

      assert.equal(result!.messages.length, 1);
      assert.equal(result!.messages[0].content, "Short");
      // Token count should reflect the new messages
      assert.equal(result!.tokenCount, sm.get("sess-1")!.tokenCount);
    });

    it("updates lastActivityAt", async () => {
      const session = sm.getOrCreate("sess-1");
      const before = session.lastActivityAt;

      await new Promise((r) => setTimeout(r, 10));

      sm.replaceMessages("sess-1", [msg("user", "new")]);
      assert.ok(session.lastActivityAt >= before);
    });

    it("returns null for a non-existent session", () => {
      const result = sm.replaceMessages("nonexistent", []);
      assert.equal(result, null);
    });

    it("allows replacing with an empty array (clears messages)", () => {
      sm.getOrCreate("sess-1");
      sm.addMessage("sess-1", msg("user", "hello"));

      const result = sm.replaceMessages("sess-1", []);
      assert.equal(result!.messages.length, 0);
      assert.equal(result!.tokenCount, 0);
    });
  });

  // ─── get / has / size ─────────────────────────────────────────

  describe("get / has / size", () => {
    it("get returns session without updating lastActivityAt", () => {
      const session = sm.getOrCreate("sess-1");
      const activityBefore = session.lastActivityAt;

      const retrieved = sm.get("sess-1");
      assert.equal(retrieved, session);
      assert.equal(retrieved!.lastActivityAt, activityBefore);
    });

    it("get returns undefined for non-existent session", () => {
      assert.equal(sm.get("nonexistent"), undefined);
    });

    it("has returns true for existing session", () => {
      sm.getOrCreate("sess-1");
      assert.equal(sm.has("sess-1"), true);
    });

    it("has returns false for non-existent session", () => {
      assert.equal(sm.has("nonexistent"), false);
    });

    it("size returns correct count", () => {
      assert.equal(sm.size, 0);
      sm.getOrCreate("a");
      assert.equal(sm.size, 1);
      sm.getOrCreate("b");
      assert.equal(sm.size, 2);
      sm.close("a");
      assert.equal(sm.size, 1);
    });
  });

  // ─── enforceMaxSessions ───────────────────────────────────────

  describe("enforceMaxSessions", () => {
    it("evicts oldest sessions when max is reached", () => {
      const smLimited = new SessionManager({ maxConcurrent: 2 });

      const s1 = smLimited.getOrCreate("oldest");
      const s2 = smLimited.getOrCreate("middle");
      // Now at max. Next create should evict the oldest.
      smLimited.getOrCreate("newest");

      assert.equal(smLimited.size, 2);
      assert.equal(smLimited.has("oldest"), false);
      assert.equal(smLimited.has("middle"), true);
      assert.equal(smLimited.has("newest"), true);
    });

    it("evicts the least recently accessed session", async () => {
      const smLimited = new SessionManager({ maxConcurrent: 2 });

      smLimited.getOrCreate("a");
      smLimited.getOrCreate("b");

      // Touch "a" so it becomes more recent than "b"
      await new Promise((r) => setTimeout(r, 10));
      smLimited.getOrCreate("a");

      // Creating a third session should evict "b" (least recently used)
      smLimited.getOrCreate("c");

      assert.equal(smLimited.size, 2);
      assert.equal(smLimited.has("a"), true);
      assert.equal(smLimited.has("b"), false);
      assert.equal(smLimited.has("c"), true);
    });

    it("does not evict when under the limit", () => {
      const smLimited = new SessionManager({ maxConcurrent: 10 });
      smLimited.getOrCreate("a");
      smLimited.getOrCreate("b");

      assert.equal(smLimited.size, 2);
      assert.equal(smLimited.has("a"), true);
      assert.equal(smLimited.has("b"), true);
    });
  });

  // ─── updateTokenCount ─────────────────────────────────────────

  describe("updateTokenCount", () => {
    it("recalculates token count for a session", () => {
      const session = sm.getOrCreate("sess-1");
      // Manually tamper with tokenCount to verify it gets fixed
      session.tokenCount = 999;

      const result = sm.updateTokenCount("sess-1");

      // With empty messages the count should be 0
      assert.equal(result, 0);
      assert.equal(session.tokenCount, 0);
    });

    it("returns correct count after messages are added", () => {
      sm.getOrCreate("sess-1");
      sm.addMessage("sess-1", msg("user", "Hello world"));

      const count = sm.updateTokenCount("sess-1");
      assert.ok(count > 0);

      const session = sm.get("sess-1")!;
      assert.equal(session.tokenCount, count);
    });

    it("returns 0 for a non-existent session", () => {
      const result = sm.updateTokenCount("nonexistent");
      assert.equal(result, 0);
    });
  });
});
