/**
 * Cache + connection-limiter policy constants.
 *
 * The canonical definitions now live in the central constants layer
 * (src/constants/cache.ts) per
 * `.betterai/rules/STANDARDS/maintainability/no-magic-numbers-import-from-constants`.
 * This module re-exports them so existing importers under src/server/cache/
 * keep working with no second copy of the values (DRY).
 */

export {
  LRU_DEFAULT_MAX,
  LRU_DEFAULT_TTL_MS,
  LIMITER_DEFAULT_MAX_IN_FLIGHT,
  LIMITER_DEFAULT_QUEUE_MAX,
} from "../../constants/cache.js";
