// src/server/cache/context-hash.ts
//
// Deterministic context-hash + LRU cache for retrieval responses.
//
// Per .betterai/rules/STANDARDS/observability/context-hash-includes-scope:
// - The hash MUST include repo_root_detected and scopes_queried.
// - Two contexts identical in everything except repo_root_detected MUST
//   produce different hashes (cross-corpus poisoning mitigation).
// - The canonicalization must be stable under key ordering.

import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

export type Scope = "global" | "repo";

export interface HashableContext {
  file_paths: string[];
  intent: string;
  symbols: string[];
  recent_diff: string;
  repo_root_detected: string | null;
  scopes_queried: Scope[];
}

/**
 * Compute a stable, scope-aware hash for a retrieval context.
 *
 * NOTE: do not refactor this to JSON.stringify(ctx) — V8 insertion order
 * is not a stability contract.  The canonical object below is hand-built
 * in a fixed key order so the hash is deterministic across runs and
 * across processes.
 */
export function contextHash(ctx: HashableContext): string {
  const canonical = JSON.stringify({
    file_paths: [...ctx.file_paths].sort(),
    intent: ctx.intent,
    symbols: [...ctx.symbols].sort(),
    recent_diff: ctx.recent_diff,
    repo_root_detected: ctx.repo_root_detected,
    scopes_queried: [...ctx.scopes_queried].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The cached value carries the retrieval response payload plus the
 * scope-tagging diagnostics so a cache hit reproduces the same audit-log
 * shape as a cache miss.
 */
export interface CachedRetrieval<T = unknown> {
  payload: T;
  scopes_queried: Scope[];
  repo_root_detected: string | null;
  overridden_global_ids: string[];
  cached_at_ms: number;
}

export interface ContextCacheOptions {
  max?: number;
  ttlMs?: number;
}

/**
 * LRU cache for context-hash → retrieval response.
 *
 * Defaults: 256 entries, 60s TTL (per v4 design and the eng review §4.4).
 *
 * The key is the hex digest from contextHash().  The cache itself is
 * scope-agnostic — the scope-discrimination happens at hash time, not at
 * cache-key time.  If you ever need to read a key for diagnostics, use
 * peek() so you don't bump recency.
 */
export class ContextCache {
  private readonly lru: LRUCache<string, CachedRetrieval>;

  constructor(opts: ContextCacheOptions = {}) {
    this.lru = new LRUCache<string, CachedRetrieval>({
      max: opts.max ?? 256,
      ttl: opts.ttlMs ?? 60_000,
    });
  }

  get<T = unknown>(key: string): CachedRetrieval<T> | undefined {
    return this.lru.get(key) as CachedRetrieval<T> | undefined;
  }

  set<T = unknown>(key: string, value: CachedRetrieval<T>): void {
    this.lru.set(key, value as CachedRetrieval);
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  clear(): void {
    this.lru.clear();
  }

  get size(): number {
    return this.lru.size;
  }
}
