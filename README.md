# Mem9

> LLM Memory Toolkit — production-grade memory management for AI agents.

14 standalone modules for token estimation, conversation compaction, quality verification, hybrid search, embedding providers, and session management.

**Zero required dependencies.** Works in Node.js 18+. Optional integrations for OpenAI (embeddings) and SQLite (persistence).

**9** = 久 (enduring memory) + 9 core capabilities.

## Installation

### npm (when available)
```bash
npm install mem9
```

### GitHub Packages
```bash
# 1. Create .npmrc in your project
echo "@ahua2020qq:registry=https://npm.pkg.github.com" > .npmrc

# 2. Install
pnpm add @ahua2020qq/mem9
```

### Direct from GitHub (no registry needed)
```bash
pnpm add github:ahua2020qq/mem9
```

Optional dependencies:

```bash
npm install openai          # For OpenAI embedding provider
npm install better-sqlite3  # For SQLite persistence
```

## Quick Start

### Token Estimation

CJK-aware token counting — accurate for Chinese, Japanese, Korean mixed with Latin text.

```ts
import { estimateTokens, estimateMessagesTokens } from "mem9";

estimateTokens("Hello world");          // ~3 tokens (4 chars/tok Latin)
estimateTokens("你好世界");              // ~3 tokens (1.5 chars/tok CJK)
estimateMessagesTokens(messages);        // Sum across all messages
```

### Conversation Compaction

Compress conversation history to fit context windows while preserving critical information.

```ts
import { compactWithQualityGuard } from "mem9";

const result = await compactWithQualityGuard({
  messages: conversationHistory,
  summarize: async (msgs, opts) => {
    // Call your LLM here
    return await llm.summarize(msgs, opts);
  },
  contextWindow: 128_000,
  reserveTokens: 8192,
  options: {
    maxRetries: 1,
    preserveRecentTurns: 3,
    qualityGuardEnabled: true,
  },
});

console.log(result.summary);      // Compressed summary
console.log(result.tokensSaved);  // Tokens freed up
console.log(result.qualityPassed); // Did it pass quality checks?
```

### Memory Store with Hybrid Search

Store memories and retrieve them with BM25 full-text + vector hybrid search.

```ts
import {
  MemoryStore,
  createOpenAIEmbeddingProvider,
} from "mem9";

// Create store with embedding provider
const provider = await createOpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});

const store = new MemoryStore({
  embeddingProvider: provider,
  defaultTopK: 6,
  defaultMinScore: 0.35,
});

// Store memories
const id = await store.store({
  content: "User prefers dark mode and Chinese language",
  metadata: { source: "conversation", tags: ["preference"] },
});

// Search with hybrid retrieval (vector 70% + BM25 30%)
const results = await store.search({
  text: "user preferences",
  strategy: "hybrid",
  topK: 5,
  filter: { tags: ["preference"] },
});

for (const r of results) {
  console.log(`[${r.similarity.toFixed(3)}] ${r.content}`);
}
```

### SQLite Persistence

For production workloads requiring durable storage.

```ts
import { SqliteMemoryStore } from "mem9/sqlite-memory-store";

const store = new SqliteMemoryStore({
  dbPath: "./data/memories.db",
  embeddingProvider: provider,
});

await store.init();
// Same API as MemoryStore — drop-in replacement
```

## Modules

| # | Module | Description |
|---|--------|-------------|
| 1 | `token-estimator` | CJK-aware token counting (1.5 chars/tok CJK, 4 chars/tok Latin) |
| 2 | `compaction` | Adaptive chunk ratio, staged summarization, progressive fallback |
| 3 | `quality-safeguard` | 5 required sections, identifier preservation, ask reflection |
| 4 | `compaction-guardian` | Quality-guarded retry loop over compaction |
| 5 | `context-window-guard` | Hard/warning context window limits |
| 6 | `bootstrap-budget` | File size budgeting for bootstrap context |
| 7 | `text-chunker` | Semantic + fixed text splitting with overlap |
| 8 | `memory-search-config` | Hybrid retrieval, MMR, temporal decay configuration |
| 9 | `embedding-provider` | OpenAI/Ollama/Generic embedding factory with auto-selection |
| 10 | `memory-store` | In-memory store: BM25 FTS (pre-computed TF), CJK bigram tokenizer, vector search, hybrid retrieval, auto-chunking |
| 11 | `memory-cache` | LRU cache for embeddings + query results (FNV-1a hashing) |
| 12 | `memory-flush` | Cache refresh triggering decisions |
| 13 | `session-manager` | LRU session lifecycle with 24h TTL |
| 14 | `sqlite-memory-store` | Optional SQLite persistence with FTS5 |

Import individual modules for tree-shaking:

```ts
// Full import (from npm)
import { MemoryStore, estimateTokens } from "mem9";

// Full import (from GitHub Packages)
import { MemoryStore, estimateTokens } from "@ahua2020qq/mem9";

// Sub-module import (better tree-shaking)
import { MemoryStore } from "@ahua2020qq/mem9/memory-store";
import { estimateTokens } from "@ahua2020qq/mem9/token-estimator";
```

## API Reference

### Embedding Providers

```ts
import {
  createOpenAIEmbeddingProvider,
  createOllamaEmbeddingProvider,
  createGenericEmbeddingProvider,
  createEmbeddingProvider,
} from "mem9";

// OpenAI
const openai = await createOpenAIEmbeddingProvider({
  apiKey: "...",
  model: "text-embedding-3-small",  // or text-embedding-3-large
  timeoutMs: 30_000,
});

// Ollama (local/private)
const ollama = await createOllamaEmbeddingProvider({
  baseUrl: "http://localhost:11434",
  model: "nomic-embed-text",
});

// Generic (any OpenAI-compatible API)
const generic = createGenericEmbeddingProvider({
  id: "my-provider",
  model: "my-model",
  baseUrl: "https://api.example.com/v1",
  apiKey: "...",
});

// Auto-select (tries OpenAI → Gemini → Voyage → Mistral)
const { provider } = await createEmbeddingProvider({
  provider: "auto",
  model: "text-embedding-3-small",
  apiKey: process.env.OPENAI_API_KEY,
});
```

### MemoryStore Options

```ts
const store = new MemoryStore({
  embeddingProvider: provider,     // EmbeddingProvider instance
  defaultTopK: 6,                  // Default results per query
  defaultMinScore: 0.35,           // Minimum similarity threshold
  chunkThreshold: 500,             // Auto-chunk threshold (tokens)
  maxEntries: 50_000,              // Max entries (evicts oldest)
  cacheOptions: {
    maxEntries: 500,               // Cache size
    ttlMs: 5 * 60 * 1000,         // Cache TTL (5 min)
  },
});
```

### Error Handling

All errors are typed for precise catch handling:

```ts
import {
  ValidationError,
  EmbeddingError,
  EmbeddingTimeoutError,
} from "mem9";

try {
  await store.store(entry);
} catch (e) {
  if (e instanceof EmbeddingTimeoutError) {
    console.log(`Timeout after ${e.timeoutMs}ms on ${e.provider}`);
  } else if (e instanceof ValidationError) {
    console.log(`Invalid ${e.field}: ${e.message}`);
  }
}
```

### AbortSignal Support

Long-running operations support `AbortSignal`:

```ts
const controller = new AbortController();

// Abort after 5 seconds
setTimeout(() => controller.abort(), 5_000);

const results = await store.search(
  { text: "query", strategy: "hybrid" },
  controller.signal,
);
```

## Benchmarks

| Operation | Performance |
|-----------|------------|
| Token estimation (Latin) | ~450K ops/s |
| Token estimation (CJK) | ~980K ops/s |
| BM25 full-text search | ~700K ops/s (O(1) TF lookup) |
| Text chunking (short) | ~80K ops/s |
| Text chunking (long) | ~2.6K ops/s |

## Production Hardening

- **Timeout protection** — 30s default on all embedding API calls (OpenAI/Ollama/Generic)
- **AbortSignal** — `store()`, `search()`, `storeBatch()` all accept `AbortSignal`
- **Write serializer** — Promise chain lock for concurrent write safety
- **Fine-grained lock** — Embedding compute runs in parallel, only memory writes are serialized
- **Embedding auto-chunking** — Batch size 100 (OpenAI/Generic), concurrency 5 (Ollama)
- **CJK bigram FTS** — Chinese/Japanese/Korean bigram tokenizer for full-text search
- **Pre-computed BM25** — Term frequencies computed at store time, O(1) lookup at search
- **maxEntries eviction** — 50K cap with automatic oldest-first eviction
- **Lazy TTL cleanup** — Cache cleanup once per TTL period, not per access
- **No unsafe type assertions** — All `as` casts replaced with type guards
- **269 tests**, 0 TypeScript errors

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript
pnpm test             # Run all tests (269 tests)
pnpm typecheck        # Type-check without emitting
pnpm bench            # Run benchmarks

# Individual test suites
pnpm test:token       # Token estimator
pnpm test:chunker     # Text chunker
pnpm test:compaction  # Compaction engine
pnpm test:quality     # Quality safeguard
pnpm test:store       # Memory store
pnpm test:cache       # Memory cache
pnpm test:e2e         # End-to-end scenarios
```

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.4 (for type-checking)
- Optional: `openai` >= 4.0 (embedding provider)
- Optional: `better-sqlite3` >= 9.0 (SQLite persistence)

## License

[MIT](LICENSE)

## Acknowledgments

This toolkit was developed using production-tested memory management patterns originally built for the [OpenClaw](https://github.com/openclaw/openclaw) project. Check out its Python sibling: [soul-memory-system](https://github.com/ahua2020qq/soul-memory-system).
