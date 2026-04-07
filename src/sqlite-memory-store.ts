/**
 * SQLite-backed Persistent Memory Store
 *
 * Drop-in replacement for in-memory MemoryStore with:
 *   - SQLite persistence (via better-sqlite3)
 *   - Vector search with cosine similarity (in-memory index)
 *   - Full-text search via SQLite FTS5
 *   - Hybrid retrieval with configurable weights
 *   - Compatible with MemoryStore's API surface
 *
 * Requires: npm install better-sqlite3
 * Optional dependency — only import when SQLite persistence is needed.
 */

import type { MemoryEntry, MemoryQuery, MemorySearchResult } from "./types.js";
import { cosineSimilarity, type EmbeddingProvider } from "./embedding-provider.js";
import { estimateTokens } from "./token-estimator.js";
import { chunkText, type ChunkingOptions } from "./text-chunker.js";
import { MemoryCache, type MemoryCacheOptions } from "./memory-cache.js";

// ─── Types ───────────────────────────────────────────────────────

export interface SqliteMemoryStoreOptions {
  /** Embedding provider for auto-generating vectors */
  embeddingProvider?: EmbeddingProvider;
  /** Path to SQLite database file (default "./memory.sqlite") */
  dbPath?: string;
  /** Default topK for searches (default 6) */
  defaultTopK?: number;
  /** Default minimum similarity score (default 0.35) */
  defaultMinScore?: number;
  /** Auto-chunk threshold in tokens (default 500). Set to 0 to disable. */
  chunkThreshold?: number;
  /** Chunking options passed to TextChunker when auto-chunking */
  chunkingOptions?: ChunkingOptions;
  /** Cache configuration */
  cacheOptions?: MemoryCacheOptions;
}

interface StoredEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata?: MemoryEntry["metadata"];
  createdAt: number;
  parentDocId?: string;
}

// ─── Dynamic Import Helper ───────────────────────────────────────

type BetterSqlite3 = import("better-sqlite3").Database;
type Statement = import("better-sqlite3").Statement<unknown[], unknown>;

async function loadBetterSqlite3(): Promise<BetterSqlite3> {
  try {
    const mod = await import("better-sqlite3");
    return new (mod.default || mod)();
  } catch {
    throw new Error(
      "better-sqlite3 is required for SQLite persistence. " +
      "Install it with: npm install better-sqlite3",
    );
  }
}

// ─── SQLite Memory Store ─────────────────────────────────────────

export class SqliteMemoryStore {
  private db!: BetterSqlite3;
  private readonly provider?: EmbeddingProvider;
  private readonly defaultTopK: number;
  private readonly defaultMinScore: number;
  private readonly chunkThreshold: number;
  private readonly chunkingOptions?: ChunkingOptions;
  readonly cache: MemoryCache;

  // In-memory embedding index for fast vector search
  private embeddingIndex = new Map<string, number[]>();

  // Parent doc → child chunk IDs
  private parentIndex = new Map<string, string[]>();

  private nextId = 1;
  private initialized = false;

  // Prepared statements (set during init)
  private stmtInsert!: Statement;
  private stmtGet!: Statement;
  private stmtDelete!: Statement;
  private stmtSearchFts!: Statement;
  private stmtCount!: Statement;

  constructor(private readonly options?: SqliteMemoryStoreOptions) {
    this.provider = options?.embeddingProvider;
    this.defaultTopK = options?.defaultTopK ?? 6;
    this.defaultMinScore = options?.defaultMinScore ?? 0.35;
    this.chunkThreshold = options?.chunkThreshold ?? 500;
    this.chunkingOptions = options?.chunkingOptions;
    this.cache = new MemoryCache(options?.cacheOptions);
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Initialize the SQLite database and create tables.
   * Must be called before any other operations.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const dbPath = this.options?.dbPath ?? "./memory.sqlite";
    const mod = await import("better-sqlite3");
    const Database = mod.default || mod;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent reads
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        parent_doc_id TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id,
        content,
        content='memories',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, content)
        VALUES (new.rowid, new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, content)
        VALUES ('delete', old.rowid, old.id, old.content);
      END;
    `);

    // Prepare statements
    this.stmtInsert = this.db.prepare(
      "INSERT INTO memories (id, content, embedding, metadata, created_at, parent_doc_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtGet = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    this.stmtDelete = this.db.prepare("DELETE FROM memories WHERE id = ?");
    this.stmtSearchFts = this.db.prepare(`
      SELECT m.id, m.content, m.metadata, m.created_at, m.parent_doc_id,
             rank AS fts_rank
      FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.stmtCount = this.db.prepare("SELECT COUNT(*) as count FROM memories");

    // Load existing embeddings into memory index
    this.loadEmbeddingIndex();

    // Set next ID
    const maxId = this.db.prepare(
      "SELECT id FROM memories WHERE id LIKE 'mem_%' ORDER BY CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT 1",
    ).get() as { id: string } | undefined;
    if (maxId) {
      this.nextId = parseInt(maxId.id.replace("mem_", ""), 10) + 1;
    }

    // Load parent index
    this.loadParentIndex();

    this.initialized = true;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.initialized = false;
    }
  }

  // ─── Write ────────────────────────────────────────────────────

  async store(entry: MemoryEntry): Promise<string> {
    this.ensureInit();
    const tokenCount = estimateTokens(entry.content);

    if (this.chunkThreshold > 0 && tokenCount > this.chunkThreshold) {
      return this.storeChunked(entry);
    }

    return this.storeSingle(entry);
  }

  private async storeSingle(entry: MemoryEntry, parentDocId?: string): Promise<string> {
    const id = `mem_${this.nextId++}`;

    let embedding = entry.embedding;
    if (!embedding && this.provider) {
      embedding = this.cache.getEmbedding(entry.content);
      if (!embedding) {
        embedding = await this.provider.embedQuery(entry.content);
        this.cache.setEmbedding(entry.content, embedding);
      }
    }

    const metadata = entry.metadata ?? {};
    const createdAt = metadata.timestamp ?? Date.now();

    this.stmtInsert.run(
      id,
      entry.content,
      embedding ? JSON.stringify(embedding) : null,
      JSON.stringify(metadata),
      createdAt,
      parentDocId ?? null,
    );

    // Update in-memory index
    if (embedding) {
      this.embeddingIndex.set(id, embedding);
    }

    this.cache.invalidateQueries();
    return id;
  }

  private async storeChunked(entry: MemoryEntry): Promise<string> {
    const parentId = `doc_${this.nextId++}`;
    const chunks = chunkText(entry.content, this.chunkingOptions);
    const childIds: string[] = [];

    let embeddings: number[][] | undefined;
    if (!entry.embedding && this.provider) {
      const texts = chunks.map((c) => c.text);
      embeddings = await this.provider.embedBatch(texts);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkEntry: MemoryEntry = {
        content: chunk.text,
        metadata: {
          ...entry.metadata,
          chunkIndex: i,
          totalChunks: chunks.length,
        },
        embedding: entry.embedding ? undefined : embeddings?.[i],
      };

      const childId = await this.storeSingle(chunkEntry, parentId);
      childIds.push(childId);
    }

    this.parentIndex.set(parentId, childIds);
    return parentId;
  }

  async storeBatch(entries: MemoryEntry[]): Promise<string[]> {
    this.ensureInit();
    const ids: string[] = [];
    for (const entry of entries) {
      ids.push(await this.store(entry));
    }
    return ids;
  }

  // ─── Search ───────────────────────────────────────────────────

  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    this.ensureInit();
    const topK = query.topK ?? this.defaultTopK;
    const minScore = query.minSimilarity ?? this.defaultMinScore;
    const strategy = query.strategy ?? "hybrid";

    // Check cache
    const filterHash = this.hashFilter(query.filter);
    const cached = this.cache.getQueryResults(query.text, filterHash);
    if (cached) return cached.slice(0, topK);

    let results: MemorySearchResult[];

    if (strategy === "vector" || strategy === "hybrid") {
      const vectorResults = await this.vectorSearch(query.text, topK * 4, query.filter);
      if (strategy === "vector") {
        results = vectorResults.filter((r) => r.similarity >= minScore).slice(0, topK);
      } else {
        const textResults = this.fullTextSearch(query.text, topK * 4, query.filter);
        results = this.mergeResults(vectorResults, textResults, topK, minScore);
      }
    } else {
      const textResults = this.fullTextSearch(query.text, topK * 4, query.filter);
      results = textResults.filter((r) => r.similarity >= minScore).slice(0, topK);
    }

    this.cache.setQueryResults(query.text, results, filterHash);
    return results;
  }

  // ─── Management ───────────────────────────────────────────────

  delete(id: string): boolean {
    this.ensureInit();

    // Check parent doc
    const children = this.parentIndex.get(id);
    if (children) {
      const deleteMany = this.db.prepare("DELETE FROM memories WHERE id = ?");
      const deleteManyFts = this.db.prepare(
        "INSERT INTO memories_fts(memories_fts, rowid, id, content) SELECT 'delete', rowid, id, content FROM memories WHERE id = ?",
      );

      const transaction = this.db.transaction(() => {
        for (const childId of children) {
          this.embeddingIndex.delete(childId);
          deleteManyFts.run(childId);
          deleteMany.run(childId);
        }
      });
      transaction();

      this.parentIndex.delete(id);
      this.cache.invalidateQueries();
      return true;
    }

    const entry = this.stmtGet.get(id);
    if (!entry) return false;

    this.embeddingIndex.delete(id);
    this.stmtDelete.run(id);

    // Clean up parent index if this was a chunk
    const row = entry as { parent_doc_id?: string };
    if (row.parent_doc_id) {
      const siblings = this.parentIndex.get(row.parent_doc_id);
      if (siblings) {
        const idx = siblings.indexOf(id);
        if (idx >= 0) siblings.splice(idx, 1);
        if (siblings.length === 0) this.parentIndex.delete(row.parent_doc_id);
      }
    }

    this.cache.invalidateQueries();
    return true;
  }

  get(id: string): StoredEntry | undefined {
    this.ensureInit();
    const row = this.stmtGet.get(id) as DbRow | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  getStats(): {
    totalEntries: number;
    parentDocs: number;
    embeddingCacheSize: number;
    queryCacheSize: number;
    embeddingHitRate: number;
    queryHitRate: number;
  } {
    this.ensureInit();
    const row = this.stmtCount.get() as { count: number };
    const cacheStats = this.cache.getStats();
    return {
      totalEntries: row.count,
      parentDocs: this.parentIndex.size,
      embeddingCacheSize: cacheStats.embeddingCacheSize,
      queryCacheSize: cacheStats.queryCacheSize,
      embeddingHitRate: cacheStats.embeddingHitRate,
      queryHitRate: cacheStats.queryHitRate,
    };
  }

  clear(): void {
    this.ensureInit();
    this.db.exec("DELETE FROM memories");
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
    this.embeddingIndex.clear();
    this.parentIndex.clear();
    this.cache.clear();
    this.nextId = 1;
  }

  // ─── Vector Search (in-memory) ────────────────────────────────

  private async vectorSearch(
    queryText: string,
    limit: number,
    filter?: MemoryQuery["filter"],
  ): Promise<MemorySearchResult[]> {
    if (!this.provider || this.embeddingIndex.size === 0) return [];

    let queryEmbedding = this.cache.getEmbedding(queryText);
    if (!queryEmbedding) {
      queryEmbedding = await this.provider.embedQuery(queryText);
      this.cache.setEmbedding(queryText, queryEmbedding);
    }

    // Build candidate set (apply filters)
    let candidates = Array.from(this.embeddingIndex.entries());
    if (filter?.source || filter?.tags || filter?.since) {
      candidates = candidates.filter(([id]) => {
        const entry = this.get(id);
        if (!entry) return false;
        if (filter.source && entry.metadata?.source !== filter.source) return false;
        if (filter.tags?.length && !filter.tags.some((t) => entry.metadata?.tags?.includes(t))) return false;
        if (filter.since && (entry.metadata?.timestamp ?? entry.createdAt) < filter.since) return false;
        return true;
      });
    }

    const scored: MemorySearchResult[] = [];
    for (const [id, embedding] of candidates) {
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      const entry = this.get(id);
      scored.push({
        id,
        content: entry?.content ?? "",
        similarity,
        metadata: entry?.metadata as Record<string, unknown> | undefined,
      });
    }

    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  // ─── FTS5 Search ──────────────────────────────────────────────

  private fullTextSearch(
    queryText: string,
    limit: number,
    filter?: MemoryQuery["filter"],
  ): MemorySearchResult[] {
    // Tokenize for FTS5 query
    const tokens = queryText
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1);

    if (tokens.length === 0) return [];

    const ftsQuery = tokens.map((t) => `${t}*`).join(" OR ");
    const rows = this.stmtSearchFts.all(ftsQuery, limit) as DbRow[];

    let results: MemorySearchResult[] = rows.map((row) => ({
      id: row.id,
      content: row.content,
      similarity: 1 / (1 + Math.abs(row.fts_rank)), // Convert FTS rank to 0-1 score
      metadata: this.parseMetadata(row.metadata),
    }));

    // Apply filters
    if (filter?.source || filter?.tags || filter?.since) {
      results = results.filter((r) => {
        if (filter.source && r.metadata?.source !== filter.source) return false;
        if (filter.tags?.length && !filter.tags.some((t) => (r.metadata?.tags as string[])?.includes(t))) return false;
        if (filter.since && ((r.metadata?.timestamp as number) ?? 0) < filter.since!) return false;
        return true;
      });
    }

    return results;
  }

  // ─── Hybrid Merge ─────────────────────────────────────────────

  private mergeResults(
    vectorResults: MemorySearchResult[],
    textResults: MemorySearchResult[],
    topK: number,
    minScore: number,
  ): MemorySearchResult[] {
    const VECTOR_WEIGHT = 0.7;
    const TEXT_WEIGHT = 0.3;

    const merged = new Map<string, MemorySearchResult>();

    for (const r of vectorResults) {
      merged.set(r.id, { ...r, similarity: r.similarity * VECTOR_WEIGHT });
    }

    for (const r of textResults) {
      const existing = merged.get(r.id);
      if (existing) {
        existing.similarity += r.similarity * TEXT_WEIGHT;
      } else {
        merged.set(r.id, { ...r, similarity: r.similarity * TEXT_WEIGHT });
      }
    }

    return Array.from(merged.values())
      .filter((r) => r.similarity >= minScore)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("SqliteMemoryStore not initialized. Call init() first.");
    }
  }

  private loadEmbeddingIndex(): void {
    const rows = this.db.prepare(
      "SELECT id, embedding FROM memories WHERE embedding IS NOT NULL",
    ).all() as { id: string; embedding: string | null }[];

    for (const row of rows) {
      if (row.embedding) {
        try {
          this.embeddingIndex.set(row.id, JSON.parse(row.embedding));
        } catch {
          // Skip corrupted embeddings
        }
      }
    }
  }

  private loadParentIndex(): void {
    const rows = this.db.prepare(
      "SELECT id, parent_doc_id FROM memories WHERE parent_doc_id IS NOT NULL",
    ).all() as { id: string; parent_doc_id: string }[];

    for (const row of rows) {
      const children = this.parentIndex.get(row.parent_doc_id) ?? [];
      children.push(row.id);
      this.parentIndex.set(row.parent_doc_id, children);
    }
  }

  private parseMetadata(raw: string | null): Record<string, unknown> | undefined {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private rowToEntry(row: DbRow): StoredEntry {
    return {
      id: row.id,
      content: row.content,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      metadata: this.parseMetadata(row.metadata) as MemoryEntry["metadata"],
      createdAt: row.created_at,
      parentDocId: row.parent_doc_id ?? undefined,
    };
  }

  private hashFilter(filter?: MemoryQuery["filter"]): string {
    if (!filter) return "";
    return `${filter.source ?? ""}|${filter.tags?.join(",") ?? ""}|${filter.since ?? ""}`;
  }
}

// ─── DB Row Type ─────────────────────────────────────────────────

interface DbRow {
  id: string;
  content: string;
  embedding: string | null;
  metadata: string | null;
  created_at: number;
  parent_doc_id: string | null;
  fts_rank: number;
}
