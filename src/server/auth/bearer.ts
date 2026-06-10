// src/server/auth/bearer.ts
//
// Bearer-token middleware for hono, plus DNS-rebinding mitigation via
// Host-header verification.
//
// Per .betterai/rules/STANDARDS/security/mcp-tools-require-bearer:
//   - Every MCP tool MUST go through this middleware.
//   - The health-check endpoint is the ONLY allowlisted path.
//   - Every health bypass MUST emit an audit-log entry (ip + UA).
//
// Host allowlist (G4): there are NO host literals in this file. The
// allowlist is either injected by the caller (main.ts derives it via
// contracts/env.ts `allowedHostsFromEnv`) or derived here from the same
// helper's process-env wrapper — ONE source of truth, in the env layer,
// per config-from-env-not-hardcoded.
//
// TOKEN ROTATION SEMANTICS (G4 decision — option (b), restart required):
//   The token is read ONCE at construction and cached for the process
//   lifetime. Rotating the token file on disk has NO effect on a running
//   server; restart the server to pick up the new value. We chose
//   restart-required over mtime polling because (1) the install script
//   writes the token exactly once before startup, (2) re-reading on the
//   hot auth path adds a disk stat per request, and (3) a half-written
//   token file mid-rotation would intermittently 401 valid clients. In
//   exchange we fail LOUD at startup: missing or empty/whitespace-only
//   token files throw typed errors before the listener ever binds.
//
//   Trim semantics: the token value is trim()ed at read time because the
//   install script writes a trailing newline — a file containing
//   "token\n" matches the header value "token".

import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import {
  DEFAULT_TOKEN_PATH,
  allowedHostsFromProcessEnv,
} from "../../contracts/env.js";

// ---- Typed errors -------------------------------------------------------
//
// Per STANDARDS/error-handling/typed-errors-from-errors-layer the bearer
// bootstrap errors now live in the central src/errors/ layer (BAI-1xx
// bootstrap block) and are re-exported here so existing callers + tests that
// import them from this module keep working. Codes (BAI-101/102) and messages
// are unchanged.
export {
  BearerTokenError,
  BearerTokenMissingError,
  BearerTokenEmptyError,
} from "../../errors/index.js";
import {
  BearerTokenMissingError,
  BearerTokenEmptyError,
} from "../../errors/index.js";

// ---- Options -------------------------------------------------------------

export interface BearerOptions {
  /** Path to the token file. Default: BETTERAI_TOKEN_PATH's default. */
  tokenPath?: string;
  /** Routes that may skip the bearer check. */
  unauthenticatedPaths?: Set<string>;
  /**
   * Hosts the server will accept; rejects everything else (DNS
   * rebinding). When omitted, derived from the environment via
   * contracts/env.ts `allowedHostsFromProcessEnv` (BETTERAI_ALLOWED_HOSTS
   * override, else BETTERAI_BIND_HOST:BETTERAI_MCP_PORT + localhost alias).
   */
  allowedHosts?: Set<string>;
  /**
   * Audit-bypass emitter.  Called from the health-path branch.  Real
   * implementations pipe this to the JSONL writer.
   */
  onBypass?: (info: { path: string; ip: string; ua: string }) => void;
}

const DEFAULT_UNAUTHENTICATED_PATHS = new Set(["/health"]);

/**
 * Read and cache the bearer token.  Throws a typed error at construction
 * time if the file is missing or blank — we'd rather fail loud at
 * startup than 401 every request silently.  See the rotation-semantics
 * comment at the top of this file: this is the ONLY read; rotation
 * requires a restart.
 */
function readToken(path: string): string {
  if (!existsSync(path)) {
    throw new BearerTokenMissingError(path);
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    throw new BearerTokenEmptyError(path);
  }
  return raw;
}

/**
 * Build a hono middleware that enforces:
 *   1. Host header is on the allowlist (defense against DNS rebinding).
 *   2. Authorization: Bearer <token> matches the file's contents.
 *
 * Returns 401 with `{ error: "unauthorized" }` on any failure.
 */
export function bearerMiddleware(opts: BearerOptions = {}): MiddlewareHandler {
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  const token = readToken(tokenPath);
  const allowedHosts = opts.allowedHosts ?? allowedHostsFromProcessEnv();
  const unauth = opts.unauthenticatedPaths ?? DEFAULT_UNAUTHENTICATED_PATHS;
  const { onBypass } = opts;

  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (unauth.has(path)) {
      if (onBypass) {
        onBypass({
          path,
          ip:
            c.req.header("x-forwarded-for") ??
            c.req.header("x-real-ip") ??
            "unknown",
          ua: c.req.header("user-agent") ?? "unknown",
        });
      }
      return next();
    }

    const host = c.req.header("host") ?? "";
    if (!allowedHosts.has(host)) {
      return c.json({ error: "host_not_allowed" }, 401);
    }

    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !constantTimeEqual(match[1], token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}

/**
 * Constant-time string compare built on node:crypto `timingSafeEqual`.
 * Both inputs are SHA-256 hashed to equal-length buffers first, so
 * neither the content nor the LENGTH of the secret leaks through
 * early-return timing.  Exported for structural/behavioral tests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
