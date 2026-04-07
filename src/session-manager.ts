/**
 * Session Manager
 *
 * LRU-based session management with idle eviction.
 * Tracks active sessions, enforces concurrency limits,
 * and evicts idle sessions to free memory.
 */

import type { ConversationMessage, Session, SessionManagerOptions } from "./types.js";
import { estimateMessagesTokens } from "./token-estimator.js";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 5000;
const DEFAULT_IDLE_TTL_MS = 86_400_000; // 24 hours

// ─── Session Manager Class ───────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly maxConcurrent: number;
  private readonly idleTtlMs: number;

  constructor(options?: SessionManagerOptions) {
    this.maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.idleTtlMs = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Get an existing session or create a new one.
   * Updates lastActivityAt on access (LRU behavior).
   */
  getOrCreate(key: string): Session {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const now = Date.now();
    const session: Session = {
      key,
      messages: [],
      createdAt: now,
      lastActivityAt: now,
      tokenCount: 0,
    };

    this.sessions.set(key, session);
    this.enforceMaxSessions();
    return session;
  }

  /**
   * Close a specific session.
   * Returns true if the session existed and was closed.
   */
  close(key: string): boolean {
    return this.sessions.delete(key);
  }

  /**
   * Evict sessions that have been idle longer than TTL.
   * Returns the number of evicted sessions.
   */
  evictIdle(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt > this.idleTtlMs) {
        this.sessions.delete(key);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Add a message to a session and update token count.
   */
  addMessage(key: string, message: ConversationMessage): Session | null {
    const session = this.sessions.get(key);
    if (!session) return null;

    session.messages.push(message);
    session.lastActivityAt = Date.now();
    session.tokenCount = estimateMessagesTokens(session.messages);
    return session;
  }

  /**
   * Get all active sessions.
   */
  getActive(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a session by key without updating lastActivityAt.
   */
  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * Get current number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Check if a session exists.
   */
  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /**
   * Update session's token count (call after compaction).
   */
  updateTokenCount(key: string): number {
    const session = this.sessions.get(key);
    if (!session) return 0;

    session.tokenCount = estimateMessagesTokens(session.messages);
    return session.tokenCount;
  }

  /**
   * Replace session messages (e.g., after compaction).
   */
  replaceMessages(key: string, messages: ConversationMessage[]): Session | null {
    const session = this.sessions.get(key);
    if (!session) return null;

    session.messages = messages;
    session.lastActivityAt = Date.now();
    session.tokenCount = estimateMessagesTokens(messages);
    return session;
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Enforce max concurrent session limit by evicting oldest.
   */
  private enforceMaxSessions(): void {
    if (this.sessions.size <= this.maxConcurrent) return;

    // Sort by lastActivityAt ascending (oldest first)
    const entries = Array.from(this.sessions.entries()).sort(
      (a, b) => a[1].lastActivityAt - b[1].lastActivityAt,
    );

    const toEvict = this.sessions.size - this.maxConcurrent;
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.sessions.delete(entries[i][0]);
    }
  }
}
