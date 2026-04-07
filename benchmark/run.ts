/**
 * Benchmark suite for mem9
 *
 * Measures throughput and latency for core operations:
 *   1. Token estimation (Latin, CJK, mixed)
 *   2. Text chunking (semantic, fixed, short, long)
 *   3. Adaptive compaction ratio computation
 *   4. MemoryStore: store, FTS search, hybrid search
 *
 * Run: node --import tsx benchmark/run.ts
 */

import { performance } from "node:perf_hooks";
import { estimateTokens, estimateMessagesTokens } from "../src/token-estimator.js";
import { chunkText } from "../src/text-chunker.js";
import { computeAdaptiveChunkRatio } from "../src/compaction.js";
import { MemoryStore } from "../src/memory-store.js";

// ─── Helpers ─────────────────────────────────────────────────────

function bench(name: string, iterations: number, fn: () => void): void {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round(iterations / (elapsed / 1000));
  const usPerOp = (elapsed / iterations * 1000).toFixed(2);

  console.log(`  ${name}: ${usPerOp} µs/op | ${opsPerSec.toLocaleString()} ops/s`);
}

// ─── Data generators ─────────────────────────────────────────────

function generateLatinText(words: number): string {
  const vocab = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "hello", "world", "test", "data", "memory", "search", "compaction", "token"];
  return Array.from({ length: words }, () => vocab[Math.floor(Math.random() * vocab.length)]).join(" ");
}

function generateCJKText(chars: number): string {
  const vocab = "你好世界测试中文文本处理搜索引擎压缩摘要令牌估算";
  return Array.from({ length: chars }, () => vocab[Math.floor(Math.random() * vocab.length)]).join("");
}

function generateMixedText(length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += Math.random() > 0.5 ? "Hello world " : "你好世界";
  }
  return text;
}

// ─── Benchmarks ──────────────────────────────────────────────────

console.log("\n=== Token Estimation ===\n");

const latinShort = generateLatinText(20);
const latinLong = generateLatinText(500);
const cjkShort = generateCJKText(30);
const cjkLong = generateCJKText(500);
const mixedMed = generateMixedText(50);

bench("Latin short (20 words)", 10000, () => estimateTokens(latinShort));
bench("Latin long (500 words)", 10000, () => estimateTokens(latinLong));
bench("CJK short (30 chars)", 10000, () => estimateTokens(cjkShort));
bench("CJK long (500 chars)", 10000, () => estimateTokens(cjkLong));
bench("Mixed (50 segments)", 10000, () => estimateTokens(mixedMed));

console.log("\n=== Text Chunking ===\n");

const shortText = generateLatinText(50);
const longText = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${generateLatinText(30)}`).join("\n\n");
const cjkText = Array.from({ length: 20 }, (_, i) => `第${i}段：${generateCJKText(50)}`).join("\n\n");

bench("Semantic short text", 5000, () => chunkText(shortText, { maxTokens: 100 }));
bench("Semantic long text", 1000, () => chunkText(longText, { maxTokens: 200, overlapTokens: 40 }));
bench("Semantic CJK text", 1000, () => chunkText(cjkText, { maxTokens: 200 }));
bench("Fixed long text", 1000, () => chunkText(longText, { strategy: "fixed", maxTokens: 200 }));

console.log("\n=== Adaptive Compaction Ratio ===\n");

const smallMsgs = Array.from({ length: 10 }, () => ({ role: "user" as const, content: generateLatinText(20) }));
const largeMsgs = Array.from({ length: 50 }, () => ({ role: "user" as const, content: generateLatinText(200) }));

bench("Small messages (10 × 20 words)", 10000, () => computeAdaptiveChunkRatio(smallMsgs, 200000));
bench("Large messages (50 × 200 words)", 10000, () => computeAdaptiveChunkRatio(largeMsgs, 200000));

console.log("\n=== MemoryStore Operations ===\n");

async function runStoreBenchmarks(): Promise<void> {
  const store = new MemoryStore();

  // Pre-populate
  for (let i = 0; i < 100; i++) {
    await store.store({
      content: `Document ${i}: ${generateLatinText(50)} with topic-${i} and project-proj-${i}`,
      metadata: { source: "bench", tags: [`tag-${i % 5}`], timestamp: Date.now() },
    });
  }

  console.log(`  Store populated: ${store.getStats().totalEntries} entries\n`);

  // Store benchmark
  bench("store() single entry", 1000, async () => {
    await store.store({ content: generateLatinText(30) });
  });

  // FTS search
  bench("FTS search (single term)", 1000, async () => {
    await store.search({ text: "project", strategy: "fulltext" });
  });

  // Multi-term FTS
  bench("FTS search (multi-term)", 1000, async () => {
    await store.search({ text: "project document test", strategy: "fulltext" });
  });

  // Hybrid search (no embeddings, falls back to FTS-only effectively)
  bench("Hybrid search", 1000, async () => {
    await store.search({ text: "topic project memory", strategy: "hybrid" });
  });

  // Filtered search
  bench("FTS search with tag filter", 1000, async () => {
    await store.search({ text: "project", strategy: "fulltext", filter: { tags: ["tag-0"] } });
  });

  console.log("");
}

// Run async benchmarks
await runStoreBenchmarks();

console.log("=== Done ===\n");
