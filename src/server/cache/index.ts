// src/server/cache/index.ts
//
// Public surface of the cache module.
//
// Re-exports the lower-level pieces (ContextCache, contextHash, types)
// and provides a small generic factory that the test harness + tools
// use when they want a typed LRU keyed by arbitrary strings without
// the CachedRetrieval envelope.
//
// The factory exists so callers can ask for `createContextCache<MyT>()`
// and get back an object with `get/set/size()` — a minimal interface
// that doesn't lock them into the retrieval-specific envelope.

import { LRUCache } from "lru-cache";

export {
  ContextCache,
  contextHash,
  type CachedRetrieval,
  type ContextCacheOptions,
  type HashableContext,
  type Scope,
} from "./context-hash.js";

export interface GenericCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  size(): number;
}

export interface CreateContextCacheOptions {
  max?: number;
  ttlMs?: number;
}

/**
 * Build a small, typed LRU cache backed by `lru-cache`.
 *
 * Defaults match the retrieval cache: 256 entries, 60s TTL. The returned
 * object exposes a deliberately minimal interface so test harnesses and
 * tools can swap in a Map-backed fake without ceremony.
 */
export function createContextCache<V>(
  opts: CreateContextCacheOptions = {},
): GenericCache<V> {
  const lru = new LRUCache<string, { value: V }>({
    max: opts.max ?? 256,
    ttl: opts.ttlMs ?? 60_000,
  });
  return {
    get(key: string): V | undefined {
      const entry = lru.get(key);
      return entry?.value;
    },
    set(key: string, value: V): void {
      lru.set(key, { value });
    },
    size(): number {
      return lru.size;
    },
  };
}
