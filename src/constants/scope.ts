// src/constants/scope.ts
//
// Central constants for the repo-root detector.
//
// Per no-magic-numbers-import-from-constants: the detection cache TTL and the
// walk-up depth cap are policy values.

/** TTL (ms) for the repo-root detection cache, keyed by mtime(.git/HEAD). */
export const REPO_DETECT_CACHE_TTL_MS = 60_000;

/** Max parent directories to ascend before giving up (runaway-symlink guard). */
export const MAX_WALK_UP_DEPTH = 64;
