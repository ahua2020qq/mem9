# Changelog

All notable changes to `mem9` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
