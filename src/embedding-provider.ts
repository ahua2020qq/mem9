/**
 * Embedding Provider Factory
 *
 * Creates and manages embedding providers for vector generation.
 * Supports OpenAI, Gemini, Voyage, Mistral, Ollama, and local (node-llama-cpp).
 * Includes auto-selection with fallback for robustness.
 */

import { EmbeddingError, EmbeddingTimeoutError, ValidationError } from "./errors.js";

// ─── Timeout Helper ──────────────────────────────────────────────

const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  provider: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new EmbeddingTimeoutError(ms, provider)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

import type {
  EmbeddingProvider,
  EmbeddingProviderFallback,
  EmbeddingProviderId,
  EmbeddingProviderOptions,
  EmbeddingProviderRequest,
} from "./types.js";
export type { EmbeddingProvider } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

export interface EmbeddingProviderResult {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: EmbeddingProviderId;
  fallbackReason?: string;
  providerUnavailableReason?: string;
}

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 30_000) */
  timeoutMs?: number;
}

export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  model?: string;
  /** Per-request timeout in milliseconds (default 30_000) */
  timeoutMs?: number;
}

// ─── Remote Provider Priority (for auto-selection) ───────────────

const REMOTE_PROVIDER_IDS: EmbeddingProviderId[] = ["openai", "gemini", "voyage", "mistral"];

// ─── OpenAI Embedding Provider ───────────────────────────────────

/**
 * Create an OpenAI embedding provider.
 * Requires the `openai` npm package.
 *
 * Recommended model: text-embedding-3-small (1536 dims, cost-effective)
 * Alternative: text-embedding-3-large (3072 dims, higher quality)
 */
export async function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingOptions,
): Promise<EmbeddingProvider> {
  // Dynamic import so the package is optional
  const { default: OpenAI } = await import("openai");

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    defaultHeaders: options.headers,
  });

  const model = options.model ?? "text-embedding-3-small";
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  const BATCH_SIZE = 100; // OpenAI recommended max per request

  return {
    id: "openai",
    model,
    maxInputTokens: 8191,
    embedQuery: async (text: string) => {
      const response = await withTimeout(
        client.embeddings.create({ model, input: text }),
        timeoutMs,
        "openai",
      );
      return response.data[0].embedding;
    },
    embedBatch: async (texts: string[]) => {
      if (texts.length <= BATCH_SIZE) {
        const response = await withTimeout(
          client.embeddings.create({ model, input: texts }),
          timeoutMs,
          "openai",
        );
        return response.data.map((item) => item.embedding);
      }
      // Auto-chunk for large batches
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const response = await withTimeout(
          client.embeddings.create({ model, input: batch }),
          timeoutMs,
          "openai",
        );
        results.push(...response.data.map((d) => d.embedding));
      }
      return results;
    },
  };
}

// ─── Ollama Embedding Provider ───────────────────────────────────

/**
 * Create an Ollama embedding provider for private/local deployment.
 * Requires a running Ollama instance.
 *
 * Recommended model: nomic-embed-text
 */
export async function createOllamaEmbeddingProvider(
  options?: OllamaEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const baseUrl = options?.baseUrl ?? "http://localhost:11434";
  const model = options?.model ?? "nomic-embed-text";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;

  async function embed(text: string): Promise<number[]> {
    const response = await withTimeout(
      fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      }),
      timeoutMs,
      "ollama",
    );
    if (!response.ok) {
      throw new EmbeddingError(`Ollama embedding failed: ${response.status} ${response.statusText}`, "ollama");
    }
    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  return {
    id: "ollama",
    model,
    embedQuery: embed,
    embedBatch: async (texts: string[]) => {
      // Concurrency control — avoid flooding Ollama with thousands of requests
      const CONCURRENCY = 5;
      const results: number[][] = new Array(texts.length);
      for (let i = 0; i < texts.length; i += CONCURRENCY) {
        const batch = texts.slice(i, i + CONCURRENCY);
        const embeddings = await Promise.all(batch.map(embed));
        for (let j = 0; j < embeddings.length; j++) {
          results[i + j] = embeddings[j];
        }
      }
      return results;
    },
  };
}

// ─── Generic REST Embedding Provider ─────────────────────────────

/**
 * Create a generic embedding provider for any OpenAI-compatible API.
 * Works with self-hosted models, Azure OpenAI, etc.
 */
export function createGenericEmbeddingProvider(params: {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxInputTokens?: number;
  timeoutMs?: number;
  batchSize?: number;
}): EmbeddingProvider {
  const { id, model, baseUrl, apiKey, headers = {}, maxInputTokens, timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS, batchSize = 100 } = params;

  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  if (apiKey) {
    authHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  async function embed(text: string): Promise<number[]> {
    const response = await withTimeout(
      fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model, input: text }),
      }),
      timeoutMs,
      id,
    );
    if (!response.ok) {
      throw new EmbeddingError(`Embedding API failed: ${response.status} ${response.statusText}`, id);
    }
    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  return {
    id,
    model,
    maxInputTokens,
    embedQuery: embed,
    embedBatch: async (texts: string[]) => {
      if (texts.length <= batchSize) {
        const response = await withTimeout(
          fetch(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ model, input: texts }),
          }),
          timeoutMs,
          id,
        );
        if (!response.ok) {
          throw new EmbeddingError(`Embedding API failed: ${response.status} ${response.statusText}`, id);
        }
        const data = await response.json() as { data: Array<{ embedding: number[] }> };
        return data.data.map((item) => item.embedding);
      }
      // Auto-chunk for large batches
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const response = await withTimeout(
          fetch(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ model, input: batch }),
          }),
          timeoutMs,
          id,
        );
        if (!response.ok) {
          throw new EmbeddingError(`Embedding API failed: ${response.status} ${response.statusText}`, id);
        }
        const data = await response.json() as { data: Array<{ embedding: number[] }> };
        results.push(...data.data.map((d) => d.embedding));
      }
      return results;
    },
  };
}

// ─── Auto-Selection Factory ──────────────────────────────────────

/**
 * Create an embedding provider with auto-selection and fallback.
 *
 * Auto-selection order:
 *  1. OpenAI (if OPENAI_API_KEY available)
 *  2. Gemini (if GEMINI_API_KEY available)
 *  3. Voyage (if VOYAGE_API_KEY available)
 *  4. Mistral (if MISTRAL_API_KEY available)
 *  5. Returns null for FTS-only mode if no keys available
 */
export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const { provider, fallback } = options;

  const createById = async (id: EmbeddingProviderId): Promise<EmbeddingProvider> => {
    switch (id) {
      case "openai":
        if (!options.apiKey) throw new EmbeddingError("No API key found for provider: openai", "openai");
        return createOpenAIEmbeddingProvider({
          apiKey: options.apiKey,
          model: options.model || undefined,
          baseUrl: options.baseUrl,
          headers: options.headers,
        });
      case "ollama":
        return createOllamaEmbeddingProvider({
          baseUrl: options.baseUrl,
          model: options.model || undefined,
        });
      case "gemini":
      case "voyage":
      case "mistral":
      case "local":
        throw new EmbeddingError(
          `Provider "${id}" requires custom implementation. ` +
            `Use createGenericEmbeddingProvider() or implement your own adapter.`,
          id,
        );
      default:
        throw new ValidationError(`Unknown provider: ${id}`, "provider");
    }
  };

  if (provider === "auto") {
    const errors: string[] = [];

    for (const id of REMOTE_PROVIDER_IDS) {
      try {
        const result = await createById(id);
        return { provider: result, requestedProvider: provider };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No API key")) {
          errors.push(message);
          continue;
        }
        throw err;
      }
    }

    return {
      provider: null,
      requestedProvider: provider,
      providerUnavailableReason:
        errors.length > 0
          ? errors.join("\n\n")
          : "No embeddings provider available.",
    };
  }

  // Explicit provider
  try {
    const result = await createById(provider);
    return { provider: result, requestedProvider: provider };
  } catch (primaryErr) {
    const reason = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);

    // Try fallback
    if (fallback && fallback !== "none" && fallback !== provider) {
      try {
        const fallbackResult = await createById(fallback);
        return {
          provider: fallbackResult,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: reason,
        };
      } catch {
        // Both failed
      }
    }

    // No fallback or fallback also failed — degrade to FTS-only
    if (reason.includes("No API key")) {
      return {
        provider: null,
        requestedProvider: provider,
        providerUnavailableReason: reason,
      };
    }

    throw primaryErr;
  }
}

// ─── Vector Utilities ────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Normalize a vector to unit length.
 */
export function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
