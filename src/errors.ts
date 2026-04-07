/**
 * Error hierarchy for mem9
 *
 * All public APIs throw these typed errors so consumers can
 * distinguish between validation issues, network failures,
 * and internal logic errors.
 *
 * Usage:
 *   import { ValidationError, EmbeddingError } from "mem9";
 *   try { ... } catch (e) { if (e instanceof ValidationError) ... }
 */

// ─── Base Error ──────────────────────────────────────────────────

export class MemoryToolkitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

// ─── Validation Errors ───────────────────────────────────────────

/** Thrown when input arguments fail validation. */
export class ValidationError extends MemoryToolkitError {
  /** The parameter or field that failed validation */
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

// ─── Embedding Errors ────────────────────────────────────────────

/** Thrown when an embedding provider fails. */
export class EmbeddingError extends MemoryToolkitError {
  /** The provider ID that failed */
  readonly provider?: string;

  constructor(message: string, provider?: string, options?: ErrorOptions) {
    super(message, options);
    this.provider = provider;
  }
}

/** Thrown when an embedding API call times out. */
export class EmbeddingTimeoutError extends EmbeddingError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, provider?: string) {
    super(`Embedding request timed out after ${timeoutMs}ms`, provider);
    this.timeoutMs = timeoutMs;
  }
}

// ─── Compaction Errors ───────────────────────────────────────────

/** Thrown when compaction or summarization fails. */
export class CompactionError extends MemoryToolkitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// ─── Store Errors ────────────────────────────────────────────────

/** Thrown when a memory store operation fails. */
export class StoreError extends MemoryToolkitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Thrown when a SQLite operation fails. */
export class SqliteStoreError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
