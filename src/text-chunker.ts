/**
 * Text Chunker — split documents into token-bounded chunks.
 *
 * Strategies:
 *   - Fixed: split by estimated token count with overlap
 *   - Semantic: prefer paragraph/sentence boundaries
 *   - Message: split conversation messages by token share
 */

import { estimateTokens } from "./token-estimator.js";

// ─── Types ───────────────────────────────────────────────────────

export interface ChunkingOptions {
  /** Max tokens per chunk (default 400) */
  maxTokens?: number;
  /** Overlap tokens between chunks (default 80) */
  overlapTokens?: number;
  /** Strategy (default "semantic") */
  strategy?: "fixed" | "semantic";
  /** Separator priority for semantic splitting (default ["\n\n", "\n"]) */
  separators?: string[];
}

export interface ChunkResult {
  /** The chunk text */
  text: string;
  /** Estimated token count */
  tokens: number;
  /** Start offset in original text */
  startIndex: number;
  /** End offset in original text */
  endIndex: number;
}

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const DEFAULT_SEPARATORS = ["\n\n", "\n"];

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Split text into chunks respecting token limits and semantic boundaries.
 *
 * Algorithm:
 *   1. Split text by separator hierarchy (paragraph → line)
 *   2. Merge small splits until approaching maxTokens
 *   3. When a split would overflow, start a new chunk
 *   4. Add overlap from previous chunk's tail
 */
export function chunkText(text: string, options?: ChunkingOptions): ChunkResult[] {
  if (!text || !text.trim()) return [];

  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const strategy = options?.strategy ?? "semantic";
  const separators = options?.separators ?? DEFAULT_SEPARATORS;

  if (strategy === "fixed") {
    return chunkFixed(text, maxTokens, overlapTokens);
  }

  return chunkSemantic(text, maxTokens, overlapTokens, separators);
}

/**
 * Split an array of texts (e.g., pages, sections) into chunks.
 * Each text is chunked independently, preserving source boundaries.
 */
export function chunkTexts(texts: string[], options?: ChunkingOptions): ChunkResult[] {
  const results: ChunkResult[] = [];
  let offset = 0;

  for (const text of texts) {
    const chunks = chunkText(text, options);
    for (const chunk of chunks) {
      results.push({
        ...chunk,
        startIndex: chunk.startIndex + offset,
        endIndex: chunk.endIndex + offset,
      });
    }
    offset += text.length;
  }

  return results;
}

/**
 * Merge small chunks until they reach a target token count.
 * Useful for post-processing when chunks are too granular.
 */
export function mergeSmallChunks(
  chunks: ChunkResult[],
  minTokens: number,
): ChunkResult[] {
  if (chunks.length <= 1) return chunks;

  const result: ChunkResult[] = [];
  let current = { ...chunks[0] };

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    if (current.tokens + next.tokens < minTokens) {
      // Merge
      current = {
        text: current.text + "\n\n" + next.text,
        tokens: estimateTokens(current.text + "\n\n" + next.text),
        startIndex: current.startIndex,
        endIndex: next.endIndex,
      };
    } else {
      result.push(current);
      current = { ...next };
    }
  }

  result.push(current);
  return result;
}

// ─── Semantic Chunking ───────────────────────────────────────────

function chunkSemantic(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  separators: string[],
): ChunkResult[] {
  // Step 1: Split into leaf segments by deepest separator
  const segments = splitBySeparatorHierarchy(text, separators, 0, maxTokens);

  // Step 2: Merge segments into chunks within token budget
  const chunks: ChunkResult[] = [];
  let currentText = "";
  let currentStart = 0;
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.text);

    // Single segment exceeds budget — split it further
    if (segTokens > maxTokens && currentText.length === 0) {
      const subChunks = chunkFixed(seg.text, maxTokens, overlapTokens);
      for (const sub of subChunks) {
        chunks.push({
          ...sub,
          startIndex: seg.startIndex + sub.startIndex,
          endIndex: seg.startIndex + sub.endIndex,
        });
      }
      continue;
    }

    // Adding this segment would exceed budget → flush current chunk
    if (currentTokens + segTokens > maxTokens && currentText.length > 0) {
      chunks.push({
        text: currentText.trim(),
        tokens: estimateTokens(currentText.trim()),
        startIndex: currentStart,
        endIndex: currentStart + currentText.length,
      });

      // Start new chunk with overlap
      const overlapText = getOverlapTail(currentText, overlapTokens);
      currentText = overlapText + seg.text;
      currentStart = seg.startIndex - overlapText.length;
      currentTokens = estimateTokens(currentText);
      continue;
    }

    // Add segment to current chunk
    if (currentText.length === 0) {
      currentText = seg.text;
      currentStart = seg.startIndex;
    } else {
      currentText += "\n\n" + seg.text;
    }
    currentTokens = estimateTokens(currentText);
  }

  // Flush last chunk
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      tokens: estimateTokens(currentText.trim()),
      startIndex: currentStart,
      endIndex: currentStart + currentText.length,
    });
  }

  return chunks;
}

// ─── Fixed Chunking ──────────────────────────────────────────────

function chunkFixed(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): ChunkResult[] {
  const maxChars = maxTokens * 1.5; // approximate: avg 1.5 chars/token for mixed
  const overlapChars = overlapTokens * 1.5;
  const chunks: ChunkResult[] = [];

  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);

    // Try to break at sentence/paragraph boundary
    if (end < text.length) {
      const boundary = findBreakPoint(text, pos, end);
      if (boundary > pos) {
        end = boundary;
      }
    }

    const chunkText = text.slice(pos, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        tokens: estimateTokens(chunkText),
        startIndex: pos,
        endIndex: end,
      });
    }

    // Advance with overlap
    const advance = Math.max(1, end - pos - overlapChars);
    pos += advance;

    if (pos >= text.length) break;
  }

  return chunks;
}

// ─── Helpers ─────────────────────────────────────────────────────

interface Segment {
  text: string;
  startIndex: number;
}

function splitBySeparatorHierarchy(
  text: string,
  separators: string[],
  depth = 0,
  maxTokens = DEFAULT_MAX_TOKENS,
): Segment[] {
  if (depth >= separators.length) {
    // Deepest level: return individual characters as last resort
    return text.trim() ? [{ text: text.trim(), startIndex: 0 }] : [];
  }

  const sep = separators[depth];
  const parts = text.split(sep);
  const segments: Segment[] = [];
  let offset = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      offset += part.length + sep.length;
      continue;
    }

    const partTokens = estimateTokens(trimmed);

    // If part is still too large, recurse to next separator level
    if (partTokens > maxTokens * 2 && depth + 1 < separators.length) {
      const subSegments = splitBySeparatorHierarchy(trimmed, separators, depth + 1, maxTokens);
      for (const sub of subSegments) {
        segments.push({
          text: sub.text,
          startIndex: offset + sub.startIndex,
        });
      }
    } else {
      segments.push({
        text: trimmed,
        startIndex: offset,
      });
    }

    offset += part.length + sep.length;
  }

  return segments;
}

function findBreakPoint(text: string, start: number, end: number): number {
  // Search backwards for paragraph break, then sentence break
  for (let i = end; i > start + 1; i--) {
    const char = text[i];
    if (char === "\n") return i + 1;
    if (char === "." || char === "。" || char === "！" || char === "？") {
      return i + 1;
    }
  }
  return end;
}

function getOverlapTail(text: string, overlapTokens: number): string {
  const overlapChars = overlapTokens * 1.5;
  if (text.length <= overlapChars) return text + "\n\n";
  const tail = text.slice(-Math.floor(overlapChars));
  // Start from the first newline to avoid cutting mid-sentence
  const newlineIndex = tail.indexOf("\n");
  if (newlineIndex >= 0) {
    return tail.slice(newlineIndex + 1) + "\n\n";
  }
  return tail + "\n\n";
}
