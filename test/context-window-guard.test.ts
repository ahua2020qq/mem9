import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from "../src/context-window-guard.js";

describe("context-window-guard", () => {
  // ── Constants ──────────────────────────────────────────────────

  describe("constants", () => {
    it("CONTEXT_WINDOW_HARD_MIN_TOKENS is 16 000", () => {
      assert.equal(CONTEXT_WINDOW_HARD_MIN_TOKENS, 16_000);
    });

    it("CONTEXT_WINDOW_WARN_BELOW_TOKENS is 32 000", () => {
      assert.equal(CONTEXT_WINDOW_WARN_BELOW_TOKENS, 32_000);
    });

    it("DEFAULT_CONTEXT_TOKENS is 200 000", () => {
      assert.equal(DEFAULT_CONTEXT_TOKENS, 200_000);
    });
  });

  // ── resolveContextWindowInfo ───────────────────────────────────

  describe("resolveContextWindowInfo", () => {
    it("returns ok level for a valid large context window", () => {
      const info = resolveContextWindowInfo(100_000);
      assert.equal(info.tokens, 100_000);
      assert.equal(info.level, "ok");
      assert.equal(info.message, undefined);
    });

    it("returns ok level exactly at the warning threshold", () => {
      const info = resolveContextWindowInfo(CONTEXT_WINDOW_WARN_BELOW_TOKENS);
      assert.equal(info.tokens, CONTEXT_WINDOW_WARN_BELOW_TOKENS);
      assert.equal(info.level, "ok");
      assert.equal(info.message, undefined);
    });

    it("defaults to DEFAULT_CONTEXT_TOKENS when undefined is passed", () => {
      const info = resolveContextWindowInfo(undefined);
      assert.equal(info.tokens, DEFAULT_CONTEXT_TOKENS);
      assert.equal(info.level, "ok");
    });

    it("defaults to DEFAULT_CONTEXT_TOKENS when called with no arguments", () => {
      const info = resolveContextWindowInfo();
      assert.equal(info.tokens, DEFAULT_CONTEXT_TOKENS);
      assert.equal(info.level, "ok");
    });

    it("returns warn level for tokens between hard min and warn threshold", () => {
      const info = resolveContextWindowInfo(20_000);
      assert.equal(info.tokens, 20_000);
      assert.equal(info.level, "warn");
      assert.ok(info.message!.includes("20000"));
      assert.ok(info.message!.includes("32000"));
    });

    it("returns warn level one token below the warning threshold", () => {
      const info = resolveContextWindowInfo(CONTEXT_WINDOW_WARN_BELOW_TOKENS - 1);
      assert.equal(info.level, "warn");
    });

    it("returns warn level exactly at the hard minimum", () => {
      const info = resolveContextWindowInfo(CONTEXT_WINDOW_HARD_MIN_TOKENS);
      assert.equal(info.tokens, CONTEXT_WINDOW_HARD_MIN_TOKENS);
      assert.equal(info.level, "warn");
    });

    it("returns critical level for a too-small value", () => {
      const info = resolveContextWindowInfo(8_000);
      assert.equal(info.tokens, 8_000);
      assert.equal(info.level, "critical");
      assert.ok(info.message!.includes("8000"));
      assert.ok(info.message!.includes("16000"));
    });

    it("returns critical level for 0 (floors to 1 via Math.max)", () => {
      const info = resolveContextWindowInfo(0);
      assert.equal(info.tokens, 1);
      assert.equal(info.level, "critical");
    });

    it("returns critical level for a negative number", () => {
      const info = resolveContextWindowInfo(-500);
      assert.equal(info.tokens, 1);
      assert.equal(info.level, "critical");
    });

    it("floors fractional token counts", () => {
      const info = resolveContextWindowInfo(99_999.7);
      assert.equal(info.tokens, 99_999);
      assert.equal(info.level, "ok");
    });
  });

  // ── evaluateContextWindowGuard ─────────────────────────────────

  describe("evaluateContextWindowGuard", () => {
    it("returns ok info for a normal context window", () => {
      const info = evaluateContextWindowGuard(100_000);
      assert.equal(info.tokens, 100_000);
      assert.equal(info.level, "ok");
    });

    it("returns warn info without throwing", () => {
      const info = evaluateContextWindowGuard(20_000);
      assert.equal(info.level, "warn");
      assert.ok(info.message);
    });

    it("returns critical info without throwing when throwOnCritical is false", () => {
      const info = evaluateContextWindowGuard(8_000, false);
      assert.equal(info.level, "critical");
      assert.ok(info.message);
    });

    it("returns critical info without throwing when throwOnCritical is omitted", () => {
      const info = evaluateContextWindowGuard(5_000);
      assert.equal(info.level, "critical");
    });

    it("throws on critical level when throwOnCritical is true", () => {
      assert.throws(
        () => evaluateContextWindowGuard(8_000, true),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("8000"));
          assert.ok(err.message.includes("16000"));
          return true;
        },
      );
    });

    it("does not throw for warn level even when throwOnCritical is true", () => {
      const info = evaluateContextWindowGuard(20_000, true);
      assert.equal(info.level, "warn");
    });

    it("does not throw for ok level when throwOnCritical is true", () => {
      const info = evaluateContextWindowGuard(200_000, true);
      assert.equal(info.level, "ok");
    });

    it("delegates to resolveContextWindowInfo for default context", () => {
      const info = evaluateContextWindowGuard(undefined, false);
      assert.equal(info.tokens, DEFAULT_CONTEXT_TOKENS);
      assert.equal(info.level, "ok");
    });
  });
});
