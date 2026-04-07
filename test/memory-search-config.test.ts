import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMemorySearchConfig,
  computeTemporalDecay,
  computeMmrScore,
  mergeHybridResults,
} from "../src/memory-search-config.js";
import type { HybridSearchResult } from "../src/memory-search-config.js";

// ─── resolveMemorySearchConfig ──────────────────────────────────

describe("resolveMemorySearchConfig", () => {
  it("returns defaults when no config is provided", () => {
    const c = resolveMemorySearchConfig();

    assert.equal(c.enabled, true);
    assert.equal(c.provider, "auto");
    assert.equal(c.model, "");
    assert.equal(c.store.driver, "sqlite");
    assert.equal(c.store.path, "./memory.sqlite");
    assert.equal(c.store.vector.enabled, true);
    assert.equal(c.chunking.tokens, 400);
    assert.equal(c.chunking.overlap, 80);
    assert.equal(c.sync.onSessionStart, true);
    assert.equal(c.sync.onSearch, true);
    assert.equal(c.sync.watch, true);
    assert.equal(c.sync.watchDebounceMs, 1500);
    assert.equal(c.sync.intervalMinutes, 0);
    assert.equal(c.sync.sessions.deltaBytes, 100_000);
    assert.equal(c.sync.sessions.deltaMessages, 50);
    assert.equal(c.sync.sessions.postCompactionForce, true);
    assert.equal(c.query.maxResults, 6);
    assert.equal(c.query.minScore, 0.35);
    assert.equal(c.query.hybrid.enabled, true);
    assert.equal(c.query.hybrid.vectorWeight, 0.7);
    assert.equal(c.query.hybrid.textWeight, 0.3);
    assert.equal(c.query.hybrid.candidateMultiplier, 4);
    assert.equal(c.query.hybrid.mmr.enabled, false);
    assert.equal(c.query.hybrid.mmr.lambda, 0.7);
    assert.equal(c.query.hybrid.temporalDecay.enabled, false);
    assert.equal(c.query.hybrid.temporalDecay.halfLifeDays, 30);
    assert.equal(c.cache.enabled, true);
    assert.equal(c.cache.maxEntries, undefined);
  });

  it("uses the storePath parameter as store.path", () => {
    const c = resolveMemorySearchConfig(undefined, "/data/memory.db");
    assert.equal(c.store.path, "/data/memory.db");
  });

  it("respects override values", () => {
    const c = resolveMemorySearchConfig({
      enabled: false,
      provider: "ollama",
      model: "nomic-embed-text",
      store: {
        driver: "sqlite",
        path: "/custom/path.sqlite",
        vector: { enabled: false, extensionPath: "/ext/vec0" },
      },
      chunking: { tokens: 200, overlap: 20 },
      sync: {
        onSessionStart: false,
        onSearch: false,
        watch: false,
        watchDebounceMs: 500,
        intervalMinutes: 10,
        sessions: {
          deltaBytes: 50_000,
          deltaMessages: 25,
          postCompactionForce: false,
        },
      },
      query: {
        maxResults: 10,
        minScore: 0.5,
        hybrid: {
          enabled: false,
          vectorWeight: 0.6,
          textWeight: 0.4,
          candidateMultiplier: 8,
          mmr: { enabled: true, lambda: 0.5 },
          temporalDecay: { enabled: true, halfLifeDays: 7 },
        },
      },
      cache: { enabled: false, maxEntries: 50 },
    }, "/override/memory.sqlite");

    assert.equal(c.enabled, false);
    assert.equal(c.provider, "ollama");
    assert.equal(c.model, "nomic-embed-text");
    assert.equal(c.store.path, "/override/memory.sqlite");
    assert.equal(c.store.vector.enabled, false);
    assert.equal(c.store.vector.extensionPath, "/ext/vec0");
    assert.equal(c.chunking.tokens, 200);
    assert.equal(c.chunking.overlap, 20);
    assert.equal(c.sync.onSessionStart, false);
    assert.equal(c.sync.intervalMinutes, 10);
    assert.equal(c.sync.sessions.deltaBytes, 50_000);
    assert.equal(c.sync.sessions.postCompactionForce, false);
    assert.equal(c.query.maxResults, 10);
    assert.equal(c.query.minScore, 0.5);
    assert.equal(c.query.hybrid.enabled, false);
    assert.equal(c.query.hybrid.candidateMultiplier, 8);
    assert.equal(c.query.hybrid.mmr.enabled, true);
    assert.equal(c.query.hybrid.mmr.lambda, 0.5);
    assert.equal(c.query.hybrid.temporalDecay.enabled, true);
    assert.equal(c.query.hybrid.temporalDecay.halfLifeDays, 7);
    assert.equal(c.cache.enabled, false);
    assert.equal(c.cache.maxEntries, 50);
  });

  // ─── Range validation ─────────────────────────────────────────

  it("clamps chunking tokens to minimum 1", () => {
    const c = resolveMemorySearchConfig({ chunking: { tokens: -10, overlap: 0 } });
    assert.equal(c.chunking.tokens, 1);
  });

  it("clamps overlap to be less than tokens", () => {
    const c = resolveMemorySearchConfig({ chunking: { tokens: 50, overlap: 100 } });
    assert.equal(c.chunking.overlap, 49);
  });

  it("clamps minScore to [0, 1]", () => {
    const low = resolveMemorySearchConfig({ query: { minScore: -0.5 } });
    assert.equal(low.query.minScore, 0);

    const high = resolveMemorySearchConfig({ query: { minScore: 1.5 } });
    assert.equal(high.query.minScore, 1);
  });

  it("normalizes hybrid weights when they sum to zero", () => {
    const c = resolveMemorySearchConfig({
      query: { hybrid: { vectorWeight: 0, textWeight: 0 } },
    });
    // When sum is 0, falls back to defaults
    assert.equal(c.query.hybrid.vectorWeight, 0.7);
    assert.equal(c.query.hybrid.textWeight, 0.3);
  });

  it("normalizes hybrid weights so they sum to 1", () => {
    const c = resolveMemorySearchConfig({
      query: { hybrid: { vectorWeight: 3, textWeight: 1 } },
    });
    assert.equal(c.query.hybrid.vectorWeight, 0.75);
    assert.equal(c.query.hybrid.textWeight, 0.25);
  });

  it("clamps MMR lambda to [0, 1]", () => {
    const low = resolveMemorySearchConfig({
      query: { hybrid: { mmr: { lambda: -1 } } },
    });
    assert.equal(low.query.hybrid.mmr.lambda, 0);

    const high = resolveMemorySearchConfig({
      query: { hybrid: { mmr: { lambda: 2 } } },
    });
    assert.equal(high.query.hybrid.mmr.lambda, 1);
  });

  it("clamps candidateMultiplier to [1, 20]", () => {
    const low = resolveMemorySearchConfig({
      query: { hybrid: { candidateMultiplier: 0 } },
    });
    assert.equal(low.query.hybrid.candidateMultiplier, 1);

    const high = resolveMemorySearchConfig({
      query: { hybrid: { candidateMultiplier: 100 } },
    });
    assert.equal(high.query.hybrid.candidateMultiplier, 20);
  });

  it("clamps halfLifeDays to minimum 1", () => {
    const c = resolveMemorySearchConfig({
      query: { hybrid: { temporalDecay: { halfLifeDays: -5 } } },
    });
    assert.equal(c.query.hybrid.temporalDecay.halfLifeDays, 1);
  });

  it("floors halfLifeDays to an integer", () => {
    const c = resolveMemorySearchConfig({
      query: { hybrid: { temporalDecay: { halfLifeDays: 15.7 } } },
    });
    assert.equal(c.query.hybrid.temporalDecay.halfLifeDays, 15);
  });

  it("uses default halfLifeDays for NaN input", () => {
    const c = resolveMemorySearchConfig({
      query: { hybrid: { temporalDecay: { halfLifeDays: NaN } } },
    });
    assert.equal(c.query.hybrid.temporalDecay.halfLifeDays, 30);
  });

  it("clamps cache maxEntries to minimum 1", () => {
    const c = resolveMemorySearchConfig({ cache: { maxEntries: 0 } });
    assert.equal(c.cache.maxEntries, 1);
  });

  it("sets maxEntries to undefined for NaN", () => {
    const c = resolveMemorySearchConfig({ cache: { maxEntries: NaN } });
    assert.equal(c.cache.maxEntries, undefined);
  });

  it("clamps session deltaBytes to [0, MAX_SAFE_INTEGER]", () => {
    const c = resolveMemorySearchConfig({
      sync: { sessions: { deltaBytes: -100 } },
    });
    assert.equal(c.sync.sessions.deltaBytes, 0);
  });
});

// ─── computeTemporalDecay ───────────────────────────────────────

describe("computeTemporalDecay", () => {
  it("returns 1 for zero age (recent entry)", () => {
    assert.equal(computeTemporalDecay(0, 30), 1);
  });

  it("returns 1 when halfLifeDays is 0 (disabled)", () => {
    assert.equal(computeTemporalDecay(100, 0), 1);
  });

  it("returns 1 when halfLifeDays is negative (disabled)", () => {
    assert.equal(computeTemporalDecay(100, -5), 1);
  });

  it("returns ~0.5 at exactly one half-life", () => {
    const score = computeTemporalDecay(30, 30);
    assert.ok(Math.abs(score - 0.5) < 1e-10, `Expected ~0.5, got ${score}`);
  });

  it("returns ~0.25 at two half-lives", () => {
    const score = computeTemporalDecay(60, 30);
    assert.ok(Math.abs(score - 0.25) < 1e-10, `Expected ~0.25, got ${score}`);
  });

  it("recent entries have higher scores than old entries", () => {
    const recent = computeTemporalDecay(1, 30);
    const old = computeTemporalDecay(100, 30);
    assert.ok(recent > old, `Recent ${recent} should be > old ${old}`);
  });

  it("score decays smoothly with age", () => {
    const day1 = computeTemporalDecay(1, 30);
    const day10 = computeTemporalDecay(10, 30);
    const day30 = computeTemporalDecay(30, 30);
    const day90 = computeTemporalDecay(90, 30);
    assert.ok(day1 > day10);
    assert.ok(day10 > day30);
    assert.ok(day30 > day90);
  });

  it("longer half-life produces slower decay", () => {
    const scoreShortHalf = computeTemporalDecay(10, 7);
    const scoreLongHalf = computeTemporalDecay(10, 90);
    assert.ok(scoreLongHalf > scoreShortHalf);
  });
});

// ─── computeMmrScore ────────────────────────────────────────────

describe("computeMmrScore", () => {
  it("returns pure relevance when lambda is 1", () => {
    const score = computeMmrScore({
      querySimilarity: 0.8,
      maxSelectedSimilarity: 0.6,
      lambda: 1,
    });
    assert.equal(score, 0.8);
  });

  it("returns negative pure diversity when lambda is 0", () => {
    const score = computeMmrScore({
      querySimilarity: 0.8,
      maxSelectedSimilarity: 0.6,
      lambda: 0,
    });
    assert.equal(score, -0.6);
  });

  it("applies diversity penalty", () => {
    const highOverlap = computeMmrScore({
      querySimilarity: 0.8,
      maxSelectedSimilarity: 0.9,
      lambda: 0.5,
    });
    const lowOverlap = computeMmrScore({
      querySimilarity: 0.8,
      maxSelectedSimilarity: 0.1,
      lambda: 0.5,
    });
    assert.ok(lowOverlap > highOverlap,
      "Low overlap should produce higher MMR score");
  });

  it("balances relevance and diversity at lambda=0.5", () => {
    const score = computeMmrScore({
      querySimilarity: 0.9,
      maxSelectedSimilarity: 0.3,
      lambda: 0.5,
    });
    // 0.5 * 0.9 - 0.5 * 0.3 = 0.45 - 0.15 = 0.3
    assert.ok(Math.abs(score - 0.3) < 1e-10, `Expected 0.3, got ${score}`);
  });

  it("uses default lambda=0.7 weighting", () => {
    const score = computeMmrScore({
      querySimilarity: 1.0,
      maxSelectedSimilarity: 1.0,
      lambda: 0.7,
    });
    // 0.7 * 1.0 - 0.3 * 1.0 = 0.4
    assert.ok(Math.abs(score - 0.4) < 1e-10, `Expected 0.4, got ${score}`);
  });

  it("returns zero when all inputs are zero", () => {
    const score = computeMmrScore({
      querySimilarity: 0,
      maxSelectedSimilarity: 0,
      lambda: 0.5,
    });
    assert.equal(score, 0);
  });
});

// ─── mergeHybridResults ─────────────────────────────────────────

describe("mergeHybridResults", () => {
  const makeResult = (
    id: string,
    content: string,
    score: number,
    metadata?: Record<string, unknown>,
    embedding?: number[],
  ): HybridSearchResult => ({ id, content, score, metadata, embedding });

  it("returns empty array when both inputs are empty", () => {
    const result = mergeHybridResults({
      vectorResults: [],
      textResults: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 5,
    });
    assert.deepEqual(result, []);
  });

  it("merges vector-only results with correct weights", () => {
    const results = mergeHybridResults({
      vectorResults: [makeResult("a", "content a", 1.0)],
      textResults: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 5,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "a");
    assert.ok(Math.abs(results[0].score - 0.7) < 1e-10,
      `Expected 0.7, got ${results[0].score}`);
  });

  it("merges text-only results with correct weights", () => {
    const results = mergeHybridResults({
      vectorResults: [],
      textResults: [makeResult("b", "content b", 1.0)],
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 5,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "b");
    assert.ok(Math.abs(results[0].score - 0.3) < 1e-10,
      `Expected 0.3, got ${results[0].score}`);
  });

  it("combines scores for results appearing in both sets", () => {
    const results = mergeHybridResults({
      vectorResults: [makeResult("shared", "content", 0.8)],
      textResults: [makeResult("shared", "content", 0.6)],
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 5,
    });
    assert.equal(results.length, 1);
    // 0.8*0.7 + 0.6*0.3 = 0.56 + 0.18 = 0.74
    assert.ok(Math.abs(results[0].score - 0.74) < 1e-10,
      `Expected 0.74, got ${results[0].score}`);
  });

  it("sorts results by combined score descending", () => {
    const results = mergeHybridResults({
      vectorResults: [
        makeResult("low", "low content", 0.2),
        makeResult("high", "high content", 0.9),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 5,
    });
    assert.equal(results[0].id, "high");
    assert.equal(results[1].id, "low");
  });

  it("respects maxResults limit", () => {
    const results = mergeHybridResults({
      vectorResults: Array.from({ length: 10 }, (_, i) =>
        makeResult(`id${i}`, `content ${i}`, 1 - i * 0.05)),
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 3,
    });
    assert.equal(results.length, 3);
  });

  it("applies temporal decay to vector results with timestamps", () => {
    const nowMs = 1000 * 60 * 60 * 24 * 30; // 30 days in ms
    const results = mergeHybridResults({
      vectorResults: [
        makeResult("recent", "recent", 1.0, { timestamp: nowMs - 1000 }),
        makeResult("old", "old", 1.0, { timestamp: 0 }),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 5,
      temporalDecayEnabled: true,
      temporalDecayHalfLifeDays: 30,
      nowMs,
    });
    // Recent entry should rank higher than old entry
    assert.equal(results[0].id, "recent");
    assert.ok(results[0].score > results[1].score);
  });

  it("does not apply temporal decay when disabled", () => {
    const nowMs = 1000 * 60 * 60 * 24 * 30;
    const results = mergeHybridResults({
      vectorResults: [
        makeResult("recent", "recent", 1.0, { timestamp: nowMs - 1000 }),
        makeResult("old", "old", 1.0, { timestamp: 0 }),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 5,
      temporalDecayEnabled: false,
      nowMs,
    });
    // Both should have same score (no decay)
    assert.ok(Math.abs(results[0].score - results[1].score) < 1e-10);
  });

  // ─── MMR diversity ────────────────────────────────────────────

  it("applies MMR diversity when enabled", () => {
    // Create many similar results; MMR should pick diverse ones
    const vectorResults: HybridSearchResult[] = Array.from({ length: 10 }, (_, i) =>
      makeResult(`id${i}`, `duplicate content duplicate`, 1.0 - i * 0.01));
    const results = mergeHybridResults({
      vectorResults,
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 3,
      mmrEnabled: true,
      mmrLambda: 0.5,
    });
    assert.equal(results.length, 3);
    // With identical content and lambda=0.5, MMR should still pick them
    // (word overlap is 1.0, but combined scores differ slightly)
    assert.ok(results.every(r => r.id.startsWith("id")));
  });

  it("MMR with embeddings uses cosine similarity for diversity", () => {
    // Two very similar embeddings and one different
    const similarEmb = [1, 0, 0];
    const differentEmb = [0, 0, 1];

    const results = mergeHybridResults({
      vectorResults: [
        makeResult("a", "content a", 0.9, undefined, similarEmb),
        makeResult("b", "content b", 0.85, undefined, similarEmb),
        makeResult("c", "content c", 0.8, undefined, differentEmb),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 2,
      mmrEnabled: true,
      mmrLambda: 0.5,
    });

    assert.equal(results.length, 2);
    // "a" has highest score so gets picked first.
    // "c" is most different from "a" so should be picked over "b".
    assert.ok(results.some(r => r.id === "a"));
    assert.ok(results.some(r => r.id === "c"),
      "MMR should prefer diverse result 'c' over similar 'b'");
  });

  it("preserves metadata on merged results", () => {
    const results = mergeHybridResults({
      vectorResults: [
        makeResult("a", "content", 0.5, { source: "vec", extra: 42 }),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 5,
    });
    assert.deepEqual(results[0].metadata, { source: "vec", extra: 42 });
  });

  it("preserves embeddings on merged results", () => {
    const emb = [0.1, 0.2, 0.3];
    const results = mergeHybridResults({
      vectorResults: [makeResult("a", "content", 1.0, undefined, emb)],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 5,
    });
    assert.deepEqual(results[0].embedding, emb);
  });

  it("uses custom similarityFn when provided for MMR", () => {
    let called = false;
    const customSim = (_a: number[], _b: number[]): number => {
      called = true;
      return 0.5;
    };

    mergeHybridResults({
      vectorResults: [
        makeResult("a", "content a", 0.9, undefined, [1, 0]),
        makeResult("b", "content b", 0.8, undefined, [0, 1]),
        makeResult("c", "content c", 0.7, undefined, [1, 1]),
      ],
      textResults: [],
      vectorWeight: 1.0,
      textWeight: 0.0,
      maxResults: 2,
      mmrEnabled: true,
      mmrLambda: 0.5,
      similarityFn: customSim,
    });

    assert.ok(called, "Custom similarity function should have been called");
  });
});
