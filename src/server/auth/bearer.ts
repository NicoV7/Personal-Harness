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
// The token is read once at construction from BETTERAI_TOKEN_PATH (mode
// 0600); we trim whitespace because the install script writes a
// trailing newline.

import { existsSync, readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";

export interface BearerOptions {
  /** Path to the token file. Default: /data/token. */
  tokenPath?: string;
  /** Routes that may skip the bearer check. */
  unauthenticatedPaths?: Set<string>;
  /** Hosts the server will accept; rejects everything else (DNS rebinding). */
  allowedHosts?: Set<string>;
  /**
   * Audit-bypass emitter.  Called from the health-path branch.  Real
   * implementations pipe this to the JSONL writer.
   */
  onBypass?: (info: { path: string; ip: string; ua: string }) => void;
}

const DEFAULT_UNAUTHENTICATED_PATHS = new Set(["/health"]);
const DEFAULT_ALLOWED_HOSTS = new Set([
  "127.0.0.1:7777",
  "localhost:7777",
]);

/**
 * Read and cache the bearer token.  Throws at construction time if the
 * file is missing — we'd rather fail loud at startup than 401 every
 * request silently.
 */
function readToken(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `bearer token not found at ${path}; install script must write it before startup`,
    );
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    throw new Error(`bearer token at ${path} is empty`);
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
  const tokenPath = opts.tokenPath ?? "/data/token";
  const token = readToken(tokenPath);
  const allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const unauth = opts.unauthenticatedPaths ?? DEFAULT_UNAUTHENTICATED_PATHS;
  const onBypass = opts.onBypass;

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
 * Constant-time string compare.  Avoids leaking the token byte-by-byte
 * through early-return timing — paranoid but cheap.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
