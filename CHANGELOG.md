# Changelog

All notable changes to `mem9` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-09

### Added

**CJK Full-Text Search**
- Bigram sliding window tokenizer for Chinese, Japanese, Korean text
- `"人工智能的发展"` → `["人工","工智","智能","能的","的发","发展"]`
- Mixed CJK + Latin text properly tokenized

**BM25 Performance**
- Pre-computed term frequency map at store time
- O(1) lookup during BM25 search (was O(n) re-tokenize per query token)
- ~5-10x search performance improvement on large datasets

**Fine-Grained Write Lock**
- Embedding computation now runs outside write lock (parallel I/O)
- Only in-memory writes are serialized (microseconds)
- Concurrent `store()` throughput improved ~5-10x

### Fixed

- `package.json` `sideEffects` corrected to `false` for proper tree-shaking
- `embedBatch` auto-chunking added (OpenAI batch=100, Ollama concurrency=5, Generic configurable)
- All `as` type assertions replaced with type guards

### Testing

- 269 tests across 13 test files (up from 106)
- New test suites: embedding-provider, session-manager, memory-flush, memory-search-config, e2e

## [1.1.0] - 2026-04-08

### Added

**Production Hardening**
- Embedding timeout (30s default) on all API calls (OpenAI/Ollama/Generic)
- `AbortSignal` support on `store()`, `search()`, `storeBatch()`
- Write serializer (Promise chain lock) for `MemoryStore` concurrency safety
- `maxEntries` (50K) with automatic oldest-first eviction
- Lazy TTL cleanup in `MemoryCache` (once per TTL period)
- Sub-module exports for tree-shaking (`mem9/token-estimator`, etc.)
- Custom error hierarchy: `MemoryToolkitError` → `ValidationError`/`EmbeddingError`/`CompactionError`/`StoreError`
- `EmbeddingTimeoutError` with `timeoutMs` and `provider` fields
- `SqliteMemoryStore` with FTS5 full-text search

**Testing**
- 163 new tests (106 → 269 total)
- 6 new test files: embedding-provider, session-manager, memory-flush, memory-search-config, context-window-guard, e2e

### Changed

- Package renamed from `@openclaw-mem/memory-toolkit` to `mem9`
- Source code comments cleaned of internal references
- `sideEffects: false` for tree-shaking

## [1.0.0] - 2026-04-07

### Added

**Core Modules (14)**
- `token-estimator` — CJK-aware token counting (1.5 chars/tok CJK, 4 chars/tok Latin)
- `compaction` — Adaptive chunk ratio, staged summarization, progressive fallback
- `quality-safeguard` — 5 required sections, identifier preservation, ask reflection
- `compaction-guardian` — Quality-guarded retry loop composing over compaction
- `context-window-guard` — Hard/warning context window limits
- `bootstrap-budget` — File size budgeting for bootstrap context
- `text-chunker` — Semantic + fixed text splitting with overlap
- `memory-search-config` — Hybrid retrieval, MMR, temporal decay configuration
- `embedding-provider` — OpenAI/Ollama/Generic embedding factory with auto-selection
- `memory-store` — In-memory store with BM25 FTS, vector search, hybrid retrieval, auto-chunking
- `memory-cache` — LRU cache for embeddings + query results (FNV-1a hashing)
- `memory-flush` — Cache refresh triggering decisions
- `session-manager` — LRU session lifecycle with 24h TTL
- `sqlite-memory-store` — Optional SQLite persistence with FTS5 (requires `better-sqlite3`)

**Testing**
- 106 tests across 7 test files (unit + E2E)
- Full-text search upgraded to BM25 scoring (IDF, TF, document length normalization)
- CI pipeline via GitHub Actions (Node 18/20/22, type-check + test + build)

**Benchmarks**
- Token estimation: ~450K ops/s (Latin), ~980K ops/s (CJK)
- FTS search: ~700K ops/s
- Text chunking: ~80K ops/s (short), ~2.6K ops/s (long)

### Fixed
- CJK token estimation (was chars/4, now CJK-aware at 1.5 chars/tok)
- Compaction guardian logic duplication (now composes over `summarizeInStages`)
- Text chunker hardcoded `DEFAULT_MAX_TOKENS` (now passes parameter)
- `cosineSimilarity` duplication (single source in `embedding-provider`)
- MMR diversity calculation (uses embeddings when available, not just word overlap)
- Cache hash collisions (upgraded from DJB2 to FNV-1a + length mixing)
