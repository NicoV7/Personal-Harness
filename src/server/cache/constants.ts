/**
 * Cache + connection-limiter policy constants.
 *
 * Per `.betterai/rules/STANDARDS/maintainability/no-magic-numbers-import-from-constants`
 * — which names `context-hash.ts:78-79` as its canonical anti-pattern — the LRU
 * capacity/TTL and the limiter backpressure thresholds are policy values that must
 * live in ONE named place, not be re-spelled at every construction site.
 */

/** Max entries in the retrieval LRU cache before eviction. */
export const LRU_DEFAULT_MAX = 256;

/** Time-to-live for an LRU entry, in milliseconds (staleness budget). */
export const LRU_DEFAULT_TTL_MS = 60_000;

/** Max concurrent in-flight dispatches before requests queue. */
export const LIMITER_DEFAULT_MAX_IN_FLIGHT = 16;

/** Max queued waiters before the limiter rejects with TooManyInFlightError (429). */
export const LIMITER_DEFAULT_QUEUE_MAX = 64;
