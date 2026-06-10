// src/constants/audit.ts
//
// Central constants for the audit subsystem (JSONL writer rotation +
// missed-retrieval detector windows).
//
// Per no-magic-numbers-import-from-constants: rotation thresholds, the file
// mode, and the missed-retrieval recency/GC windows are policy values.

/** Rotation byte threshold for the active audit file (100 MB). */
export const AUDIT_MAX_BYTES = 100 * 1024 * 1024;

/** Rotation age threshold for the active audit file (30 days, ms). */
export const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Audit files are owner read/write + group read; never world-readable. */
export const AUDIT_FILE_MODE = 0o640;

/** How recently a retrieve_* must have fired to count as "covered" (ms). */
export const MISSED_RETRIEVAL_RECENCY_MS = 60_000;

/** Floor for the missed-retrieval session GC sweep window (5 min, ms). */
export const MISSED_RETRIEVAL_SESSION_GC_MS = 5 * 60_000;
