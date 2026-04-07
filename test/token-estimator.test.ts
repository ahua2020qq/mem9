import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../src/token-estimator.js";

describe("token-estimator", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      assert.equal(estimateTokens(""), 0);
    });

    it("estimates Latin text at ~4 chars/token", () => {
      // "Hello world" = 11 chars → ceil(11/4) = 3
      assert.equal(estimateTokens("Hello world"), 3);
    });

    it("estimates CJK text at ~1.5 chars/token", () => {
      // "你好世界" = 4 CJK chars → ceil(4/1.5) = 3
      assert.equal(estimateTokens("你好世界"), 3);
    });

    it("estimates mixed CJK + Latin correctly", () => {
      // "Hello你好World世界" = 4 CJK + 10 Latin
      // CJK: ceil(4/1.5) = 3, Latin: ceil(10/4) = 3 → total 6
      const tokens = estimateTokens("Hello你好World世界");
      assert.equal(tokens, 6);
    });

    it("estimates pure CJK longer text", () => {
      // Use a string of definitely-CJK characters (U+4E00 range)
      const text = "你好世界测试中文";
      const tokens = estimateTokens(text);
      // Should be > 0 and proportional to length
      assert.ok(tokens > 0);
      // CJK: ceil(N/1.5) should be approximately 2/3 of char count
      const expected = Math.ceil(text.length / 1.5);
      assert.equal(tokens, expected);
    });

    it("CJK estimation is higher than old chars/4 method", () => {
      const cjk = "这是一个中文测试文本";
      const cjkTokens = estimateTokens(cjk);
      const oldMethod = Math.ceil(cjk.length / 4);
      // CJK tokens should be >= 2x old method
      assert.ok(cjkTokens >= oldMethod * 2, `CJK ${cjkTokens} should be >= ${oldMethod * 2}`);
    });
  });

  describe("estimateMessageTokens", () => {
    it("estimates string content", () => {
      const msg = { role: "user", content: "Hello world" };
      assert.equal(estimateMessageTokens(msg), estimateTokens("Hello world"));
    });

    it("estimates array content blocks", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };
      assert.equal(
        estimateMessageTokens(msg),
        estimateTokens("Hello") + estimateTokens("World"),
      );
    });

    it("adds image token estimate", () => {
      const msg = {
        role: "user",
        content: [
          { type: "text", text: "See this" },
          { type: "image" },
        ],
      };
      assert.equal(
        estimateMessageTokens(msg),
        estimateTokens("See this") + 2000,
      );
    });

    it("returns 0 for empty content", () => {
      assert.equal(estimateMessageTokens({ role: "user" }), 0);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("sums token counts for all messages", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const expected = estimateTokens("Hello") + estimateTokens("Hi there");
      assert.equal(estimateMessagesTokens(messages), expected);
    });

    it("returns 0 for empty array", () => {
      assert.equal(estimateMessagesTokens([]), 0);
    });
  });
});
