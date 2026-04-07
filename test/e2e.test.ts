import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory-store.js";
import { compactWithQualityGuard } from "../src/compaction-guardian.js";
import { estimateTokens, estimateMessagesTokens } from "../src/token-estimator.js";
import { chunkText } from "../src/text-chunker.js";
import { resolveMemorySearchConfig } from "../src/memory-search-config.js";
import type { ConversationMessage, MemoryEntry } from "../src/types.js";
import type { SummarizeFunction } from "../src/compaction.js";

// ─── Mock LLM Summarizer ─────────────────────────────────────────

/**
 * A mock summarizer that produces structured summaries with all required sections.
 * Simulates a real LLM summarization call.
 */
const mockSummarizer: SummarizeFunction = async (messages, opts) => {
  const identifiers = messages
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? c : "";
    })
    .join(" ")
    .match(/(?:proj-\w+|task-\w+|https?:\/\/\S+|[A-Fa-f0-9]{8,})/g) ?? [];

  const asks = messages
    .filter((m) => (m as { role?: string }).role === "user")
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? c : "";
    })
    .filter(Boolean);

  const latestAsk = asks[asks.length - 1] ?? "None.";

  return [
    "## Decisions",
    `Summarized ${messages.length} messages.`,
    opts.previousSummary ? `Building on: ${opts.previousSummary.slice(0, 50)}...` : "Fresh summary.",
    "",
    "## Open TODOs",
    "Complete integration testing.",
    "",
    "## Constraints/Rules",
    "Must pass all quality checks.",
    "",
    "## Pending user asks",
    latestAsk,
    "",
    "## Exact identifiers",
    identifiers.length > 0 ? identifiers.join(", ") : "None captured.",
  ].join("\n");
};

// ─── E2E Test ─────────────────────────────────────────────────────

describe("E2E: full lifecycle", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ cacheOptions: { queryCacheEnabled: false } });
  });

  it("conversation → compaction → store → search → retrieve", async () => {
    // ─── Step 1: Simulate a conversation ───
    const conversation: ConversationMessage[] = [
      { role: "user", content: "Create project proj-alpha-42 with React" },
      { role: "assistant", content: "Created project proj-alpha-42 with React and TypeScript." },
      { role: "user", content: "Add task-task-101 for dark mode support" },
      { role: "assistant", content: "Added task-task-101: implement dark mode with CSS variables." },
      { role: "user", content: "Deploy to https://staging.example.com" },
      { role: "assistant", content: "Deployed to https://staging.example.com successfully." },
      { role: "user", content: "Check the deployment status" },
      { role: "assistant", content: "Deployment at https://staging.example.com is healthy. Build abcdef12345678." },
    ];

    const totalTokens = estimateMessagesTokens(conversation);
    assert.ok(totalTokens > 0, "Conversation should have non-zero tokens");

    // ─── Step 2: Compact with quality guard ───
    const guardResult = await compactWithQualityGuard({
      messages: conversation,
      summarize: mockSummarizer,
      contextWindow: 200000,
      reserveTokens: 1024,
      options: {
        preserveRecentTurns: 2,
        qualityGuardEnabled: true,
        maxRetries: 1,
      },
    });

    assert.ok(guardResult.summary.length > 0, "Summary should not be empty");
    assert.ok(guardResult.tokensSaved >= 0, "Should report tokens saved");
    assert.ok(guardResult.summary.includes("## Decisions"), "Should have Decisions section");
    assert.ok(guardResult.summary.includes("## Exact identifiers"), "Should have Identifiers section");

    // ─── Step 3: Resolve search config ───
    const config = resolveMemorySearchConfig(undefined, "./test-memory.sqlite");
    assert.ok(config.enabled);
    assert.equal(config.store.driver, "sqlite");

    // ─── Step 4: Store conversation chunks ───
    // Split conversation into chunks and store each
    const conversationText = conversation
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return `[${(m as { role?: string }).role}]: ${typeof c === "string" ? c : ""}`;
      })
      .join("\n");

    const chunks = chunkText(conversationText, { maxTokens: 200, overlapTokens: 40 });
    assert.ok(chunks.length > 0, "Should produce at least one chunk");

    const chunkIds: string[] = [];
    for (const chunk of chunks) {
      const entry: MemoryEntry = {
        content: chunk.text,
        metadata: {
          source: "conversation",
          timestamp: Date.now(),
          tags: ["e2e-test"],
        },
      };
      const id = await store.store(entry);
      chunkIds.push(id);
    }
    assert.ok(store.getStats().totalEntries > 0, "Store should have entries");

    // Also store the compaction summary
    const summaryId = await store.store({
      content: guardResult.summary,
      metadata: {
        source: "compaction",
        timestamp: Date.now(),
        tags: ["summary", "e2e-test"],
        importance: 0.9,
      },
    });

    // ─── Step 5: Search for project identifier ───
    const projectResults = await store.search({
      text: "proj-alpha-42",
      strategy: "fulltext",
      filter: { source: "conversation" },
    });
    assert.ok(projectResults.length > 0, "Should find results for project identifier");

    // ─── Step 6: Search for deployment URL ───
    const deployResults = await store.search({
      text: "staging example deploy",
      strategy: "fulltext",
    });
    assert.ok(deployResults.length > 0, "Should find results for deployment query");

    // ─── Step 7: Search for summary content ───
    const summaryResults = await store.search({
      text: "Decisions constraints rules",
      strategy: "fulltext",
      filter: { source: "compaction" },
    });
    assert.ok(summaryResults.length > 0, "Should find the compaction summary");

    // ─── Step 8: Verify tag filtering works end-to-end ───
    const taggedResults = await store.search({
      text: "project",
      strategy: "fulltext",
      filter: { tags: ["e2e-test"] },
    });
    assert.ok(taggedResults.length > 0, "Should find tagged results");

    // ─── Step 9: Delete and verify ───
    store.delete(summaryId);
    assert.equal(store.get(summaryId), undefined, "Deleted entry should be gone");

    const afterDelete = await store.search({
      text: "Decisions",
      strategy: "fulltext",
      filter: { source: "compaction" },
    });
    assert.equal(afterDelete.length, 0, "Should not find deleted compaction summary");

    // ─── Step 10: Clear all ───
    store.clear();
    assert.equal(store.getStats().totalEntries, 0, "Store should be empty after clear");
  });

  it("handles long document auto-chunking in full lifecycle", async () => {
    // Simulate storing a long document
    const longDoc = Array.from(
      { length: 100 },
      (_, i) => `Section ${i + 1}: This is a detailed section about topic-${i}. It contains important information about the project.`,
    ).join("\n\n");

    const chunkStore = new MemoryStore({
      chunkThreshold: 100,
      cacheOptions: { queryCacheEnabled: false },
    });

    const parentId = await chunkStore.store({
      content: longDoc,
      metadata: { source: "document", tags: ["long-doc"] },
    });

    // Should be auto-chunked
    assert.ok(parentId.startsWith("doc_"), "Should return parent doc ID");
    const stats = chunkStore.getStats();
    assert.ok(stats.totalEntries > 1, `Should have multiple chunks, got ${stats.totalEntries}`);

    // Search within the chunks
    const results = await chunkStore.search({
      text: "topic important project",
      strategy: "fulltext",
    });
    assert.ok(results.length > 0, "Should find chunks matching the query");

    // Delete parent should remove all chunks
    chunkStore.delete(parentId);
    assert.equal(chunkStore.getStats().totalEntries, 0, "All chunks should be deleted");
  });

  it("compaction quality retry loop works end-to-end", async () => {
    // Create a summarizer that fails quality on first attempt
    let callCount = 0;
    const flakySummarizer: SummarizeFunction = async (messages, opts) => {
      callCount++;

      if (callCount === 1) {
        // First call: return summary missing required sections
        return "Simple summary without structure.";
      }

      // Subsequent calls: return proper structured summary
      return mockSummarizer(messages, opts);
    };

    const messages: ConversationMessage[] = [
      { role: "user", content: "Initialize project proj-retry-test with Node.js" },
      { role: "assistant", content: "Initialized proj-retry-test with Node.js and TypeScript." },
      { role: "user", content: "Add testing framework" },
      { role: "assistant", content: "Added vitest for testing." },
    ];

    const result = await compactWithQualityGuard({
      messages,
      summarize: flakySummarizer,
      contextWindow: 200000,
      reserveTokens: 1024,
      options: {
        qualityGuardEnabled: true,
        maxRetries: 2,
      },
    });

    assert.equal(callCount, 2, "Should retry once after quality failure");
    assert.ok(result.summary.includes("## Decisions"), "Final summary should have all sections");
    assert.ok(result.attempts > 1, "Should report multiple attempts");
  });
});
