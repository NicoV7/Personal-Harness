// src/constants/cache.ts
//
// Central constants layer for cache + connection-limiter policy values.
//
// Per .betterai/rules/STANDARDS/maintainability/no-magic-numbers-import-from-constants:
// these policy literals (LRU capacity/TTL, limiter backpressure thresholds)
// live in ONE named place. This module is the canonical definition;
// src/server/cache/constants.ts re-exports from here so existing importers
// keep working without a second copy of the values.

/** Max entries in the retrieval LRU cache before eviction. */
export const LRU_DEFAULT_MAX = 256;

/** Time-to-live for an LRU entry, in milliseconds (staleness budget). */
export const LRU_DEFAULT_TTL_MS = 60_000;

/** Max concurrent in-flight dispatches before requests queue. */
export const LIMITER_DEFAULT_MAX_IN_FLIGHT = 16;

/** Max queued waiters before the limiter rejects with TooManyInFlightError (429). */
export const LIMITER_DEFAULT_QUEUE_MAX = 64;
