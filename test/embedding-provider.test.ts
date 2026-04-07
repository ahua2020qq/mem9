import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  normalizeVector,
  createGenericEmbeddingProvider,
  createEmbeddingProvider,
} from "../src/embedding-provider.js";
import { EmbeddingError, ValidationError } from "../src/errors.js";

describe("embedding-provider", () => {
  // ─── cosineSimilarity ──────────────────────────────────────────

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const vec = [1, 2, 3];
      assert.equal(cosineSimilarity(vec, vec), 1);
    });

    it("returns 0 for orthogonal vectors", () => {
      // [1, 0] dot [0, 1] = 0
      assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    });

    it("returns -1 for opposite vectors", () => {
      // [1, 0] dot [-1, 0] = -1, norms both 1
      assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    });

    it("returns 0 for vectors of different lengths", () => {
      assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
    });

    it("returns 0 for empty arrays", () => {
      assert.equal(cosineSimilarity([], []), 0);
    });

    it("returns 0 when first argument is null-ish", () => {
      assert.equal(cosineSimilarity(null as unknown as number[], [1, 2]), 0);
    });

    it("returns 0 when second argument is null-ish", () => {
      assert.equal(cosineSimilarity([1, 2], undefined as unknown as number[]), 0);
    });

    it("returns 0 when both vectors are all zeros", () => {
      assert.equal(cosineSimilarity([0, 0, 0], [0, 0, 0]), 0);
    });

    it("computes correct similarity for arbitrary vectors", () => {
      // [1, 2, 3] dot [4, 5, 6] = 4 + 10 + 18 = 32
      // normA = sqrt(1+4+9) = sqrt(14)
      // normB = sqrt(16+25+36) = sqrt(77)
      // cos = 32 / (sqrt(14)*sqrt(77)) ≈ 0.9746
      const result = cosineSimilarity([1, 2, 3], [4, 5, 6]);
      assert.ok(Math.abs(result - 0.9746) < 0.001, `expected ~0.9746, got ${result}`);
    });
  });

  // ─── normalizeVector ───────────────────────────────────────────

  describe("normalizeVector", () => {
    it("keeps a unit vector unchanged", () => {
      const unit = [1, 0, 0];
      const result = normalizeVector(unit);
      assert.deepEqual(result, [1, 0, 0]);
    });

    it("returns a zero vector unchanged", () => {
      const zero = [0, 0, 0];
      const result = normalizeVector(zero);
      assert.deepEqual(result, [0, 0, 0]);
    });

    it("normalizes a vector to unit length", () => {
      const vec = [3, 4];
      const result = normalizeVector(vec);
      // norm = sqrt(9+16) = 5 → [3/5, 4/5] = [0.6, 0.8]
      assert.deepEqual(result, [0.6, 0.8]);
    });

    it("produces a vector with norm 1", () => {
      const vec = [1, 2, 3, 4, 5];
      const result = normalizeVector(vec);
      const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
      assert.ok(Math.abs(norm - 1) < 1e-10, `norm should be 1, got ${norm}`);
    });

    it("handles a single-element vector", () => {
      const result = normalizeVector([5]);
      assert.deepEqual(result, [1]);
    });
  });

  // ─── createGenericEmbeddingProvider ────────────────────────────

  describe("createGenericEmbeddingProvider", () => {
    it("returns correct id", () => {
      const provider = createGenericEmbeddingProvider({
        id: "my-custom",
        model: "custom-model",
        baseUrl: "http://localhost:8080",
      });
      assert.equal(provider.id, "my-custom");
    });

    it("returns correct model", () => {
      const provider = createGenericEmbeddingProvider({
        id: "test",
        model: "text-embed-v1",
        baseUrl: "http://localhost:8080",
      });
      assert.equal(provider.model, "text-embed-v1");
    });

    it("returns undefined maxInputTokens when not provided", () => {
      const provider = createGenericEmbeddingProvider({
        id: "test",
        model: "m",
        baseUrl: "http://localhost:8080",
      });
      assert.equal(provider.maxInputTokens, undefined);
    });

    it("returns provided maxInputTokens", () => {
      const provider = createGenericEmbeddingProvider({
        id: "test",
        model: "m",
        baseUrl: "http://localhost:8080",
        maxInputTokens: 4096,
      });
      assert.equal(provider.maxInputTokens, 4096);
    });

    it("has embedQuery and embedBatch methods", () => {
      const provider = createGenericEmbeddingProvider({
        id: "test",
        model: "m",
        baseUrl: "http://localhost:8080",
      });
      assert.equal(typeof provider.embedQuery, "function");
      assert.equal(typeof provider.embedBatch, "function");
    });
  });

  // ─── createEmbeddingProvider (auto mode) ───────────────────────

  describe("createEmbeddingProvider", () => {
    it("auto mode with no API key either returns null or throws EmbeddingError", async () => {
      // In auto mode, the loop tries openai (no key → skip), then gemini/voyage/mistral
      // which throw hard EmbeddingError since they require custom implementation.
      // So the call either returns null (if all are "No API key") or throws.
      try {
        const result = await createEmbeddingProvider({
          provider: "auto",
          model: "text-embedding-3-small",
        });
        assert.equal(result.provider, null);
        assert.equal(result.requestedProvider, "auto");
        assert.ok(
          result.providerUnavailableReason,
          "should have an unavailable reason",
        );
      } catch (err) {
        assert.ok(err instanceof EmbeddingError, "should throw EmbeddingError");
      }
    });

    it("throws ValidationError for an unknown provider id", async () => {
      await assert.rejects(
        () =>
          createEmbeddingProvider({
            provider: "nonexistent" as unknown as "openai",
            model: "some-model",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.ok(err.message.includes("Unknown provider"));
          assert.equal(err.field, "provider");
          return true;
        },
      );
    });

    it("returns provider:null for explicit provider with no API key", async () => {
      const result = await createEmbeddingProvider({
        provider: "openai",
        model: "text-embedding-3-small",
        // no apiKey
      });
      assert.equal(result.provider, null);
      assert.equal(result.requestedProvider, "openai");
      assert.ok(
        result.providerUnavailableReason,
        "should have an unavailable reason",
      );
      assert.ok(
        result.providerUnavailableReason!.includes("No API key"),
        `reason should mention API key, got: ${result.providerUnavailableReason}`,
      );
    });
  });
});
