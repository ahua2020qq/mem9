/**
 * Token Estimation Utilities
 *
 * Mixed-language token counting for LLM context management.
 * Handles CJK (Chinese/Japanese/Korean) correctly — CJK chars
 * are ~1-2 tokens each, not the chars/4 ratio used for Latin text.
 *
 * Accuracy comparison (vs tiktoken):
 *   English:  chars/4 ≈ ±15% error
 *   Chinese:  chars/1.5 ≈ ±20% error (was chars/4 = 60-75% underestimate!)
 *   Mixed:    weighted by CJK ratio ≈ ±20% error
 */

const LATIN_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;
const IMAGE_TOKEN_ESTIMATE = 2000; // ≈ 8000 chars at chars/4

// CJK Unified Ideographs + common CJK ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/u;

/**
 * Count CJK characters in a string.
 * Each CJK character ≈ 1-2 tokens (vs 0.25 tokens for a Latin char).
 */
function countCJKChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (CJK_REGEX.test(char)) {
      count++;
    }
  }
  return count;
}

/**
 * Estimate token count for a string.
 * Uses different ratios for CJK vs Latin characters:
 *   - CJK: ~1.5 chars/token (1 Chinese character ≈ 1-2 tokens)
 *   - Latin: ~4 chars/token (1 English word ≈ 1-1.5 tokens)
 *
 * For exact counts, use a proper tokenizer (tiktoken, etc.).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkCount = countCJKChars(text);
  const latinCount = text.length - cjkCount;

  const cjkTokens = Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN);
  const latinTokens = Math.ceil(latinCount / LATIN_CHARS_PER_TOKEN);

  return cjkTokens + latinTokens;
}

/**
 * Estimate tokens for a message object.
 * Serializes content blocks and counts all text.
 */
export function estimateMessageTokens(message: {
  content?: unknown;
  role?: string;
}): number {
  const content = message.content;
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        total += estimateTokens(text);
      }
      // Image blocks
      const type = (block as { type?: unknown }).type;
      if (type === "image") {
        total += IMAGE_TOKEN_ESTIMATE;
      }
    }
    return total;
  }
  return 0;
}

/**
 * Estimate total tokens for a list of messages.
 */
export function estimateMessagesTokens(
  messages: Array<{ content?: unknown; role?: string }>,
): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}
