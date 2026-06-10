// src/constants/cli.ts
//
// Central constants for the CLI verbs (gate + replay).
//
// Per no-magic-numbers-import-from-constants: dogfooding-gate targets, the
// health-probe budget, digest/stale windows and the shared MS_PER_DAY are
// policy values. Single-digit values and loop indices stay inline at the call
// site (the rule exempts them).

/** Milliseconds in a calendar day — shared by gate + replay windows. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---- Dogfooding gate targets (betterai gate) -----------------------------

/** The dogfooding window length, in calendar days. */
export const GATE_TARGET_DAYS = 5;
/** Distinct sessions that must see >=1 rule returned during the window. */
export const GATE_TARGET_SESSIONS = 5;
/** Visible behavior changes required during the window. */
export const GATE_TARGET_BEHAVIOR_CHANGES = 3;
/** Best-effort /health probe budget (ms) for the day-1 checklist. */
export const HEALTH_PROBE_TIMEOUT_MS = 750;

// ---- replay digest (betterai replay) -------------------------------------

/** Default lookback window (days) for the replay digest. */
export const DEFAULT_DIGEST_DAYS = 7;
