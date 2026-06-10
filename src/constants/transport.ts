// src/constants/transport.ts
//
// Central constants for the MCP Streamable-HTTP transport.
//
// Per no-magic-numbers-import-from-constants: the idle-session GC window and
// the suggested client backoff are policy values. JSON-RPC error codes
// (-32700 etc.) stay at the call site — they are protocol identifiers (like
// HTTP status codes), explicitly exempted by the rule.

/**
 * Idle-session GC window. MCP clients (Claude Code et al.) keep sessions open
 * across an editing session, so this only reaps abandoned ones.
 */
export const IDLE_SESSION_GC_MS = 30 * 60_000;

/** Suggested client backoff (ms) when the connection limiter overflows. */
export const RETRY_AFTER_MS = 250;
