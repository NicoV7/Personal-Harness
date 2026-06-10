// src/contracts/env.ts
//
// SHARED CONTRACT — environment configuration (schema_version 1.5).
//
// This IS the env layer: per .betterai/rules/STANDARDS/maintainability/
// config-from-env-not-hardcoded.md, hosts/ports/paths may be hardcoded
// here (as named default constants) and NOWHERE else.
//
// Covers the EXISTING vars (mirroring src/server/main.ts EnvSchema,
// src/server/auth/bearer.ts defaults, and docker-compose.yml
// `environment:`) PLUS the NEW v1.5 vars that later waves consume:
//
//   - BETTERAI_ALLOWED_HOSTS    comma-separated host:port allowlist that
//                               overrides the bearer middleware's
//                               DNS-rebinding host check
//   - BETTERAI_RETRIEVAL_MODE   "grep" | "embedding" | "hybrid"
//                               (selects the RetrievalScorer impl;
//                               default "hybrid")
//   - BETTERAI_MODEL_CACHE_DIR  path for the baked MiniLM model
//
// The contract schema is a strict SUPERSET of the live server schema:
// every live var appears here with an identical type and default. The
// drift guard at the bottom enforces the superset relation at typecheck
// time; the live EnvSchema flips to importing this module in a later
// wave.

import { z } from "zod";
import { RETRIEVAL_MODES } from "./retrieval.js";
import type { AssertTrue, MutuallyAssignable } from "./audit.js";

// ---- Schema version --------------------------------------------------------

/** Version of the shared contracts module. Bump on any breaking change. */
export const SCHEMA_VERSION = "1.5" as const;

// ---- Named defaults (the ONLY place hosts/ports/paths are hardcoded) -------

export const DEFAULT_CORPUS_ROOT = "/data";
export const DEFAULT_AUDIT_PATH = "/data/audit/audit.jsonl";
export const DEFAULT_PROJECTS_ROOT = "/projects";
export const DEFAULT_MCP_PORT = 7777;
export const DEFAULT_TOKEN_PATH = "/data/token";
export const DEFAULT_LOG_LEVEL = "info" as const;
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_RETRIEVAL_MODE = "hybrid" as const;
/** Lives under the /data/embeddings volume mount (docker-compose.yml). */
export const DEFAULT_MODEL_CACHE_DIR = "/data/embeddings/models";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// ---- The env schema ---------------------------------------------------------

export const EnvSchema = z.object({
  // -- Existing vars (must stay identical to src/server/main.ts) ----------
  BETTERAI_CORPUS_ROOT: z.string().default(DEFAULT_CORPUS_ROOT),
  BETTERAI_AUDIT_PATH: z.string().default(DEFAULT_AUDIT_PATH),
  BETTERAI_PROJECTS_ROOT: z.string().default(DEFAULT_PROJECTS_ROOT),
  BETTERAI_MCP_PORT: z.coerce.number().int().positive().default(DEFAULT_MCP_PORT),
  BETTERAI_TOKEN_PATH: z.string().default(DEFAULT_TOKEN_PATH),
  BETTERAI_LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  /** When set, bind to this host instead of 127.0.0.1 (tests only). */
  BETTERAI_BIND_HOST: z.string().default(DEFAULT_BIND_HOST),

  // -- NEW v1.5 vars -------------------------------------------------------
  /**
   * Comma-separated `host:port` allowlist override for the bearer
   * middleware's DNS-rebinding check. Unset → derive from
   * BETTERAI_BIND_HOST + BETTERAI_MCP_PORT (see `allowedHostsFromEnv`).
   */
  BETTERAI_ALLOWED_HOSTS: z.string().optional(),
  /** Which RetrievalScorer implementation the orchestrator selects. */
  BETTERAI_RETRIEVAL_MODE: z.enum(RETRIEVAL_MODES).default(
    DEFAULT_RETRIEVAL_MODE,
  ),
  /** Directory holding the baked MiniLM model files (Phase 1.5). */
  BETTERAI_MODEL_CACHE_DIR: z.string().default(DEFAULT_MODEL_CACHE_DIR),
});

export type ResolvedEnv = z.infer<typeof EnvSchema>;

// ---- Helpers -----------------------------------------------------------------

/**
 * Resolve the Host-header allowlist for the bearer middleware.
 * BETTERAI_ALLOWED_HOSTS (comma-separated, whitespace-tolerant) wins;
 * otherwise the allowlist is derived from the bind host + port, plus the
 * conventional localhost spelling.
 */
export function allowedHostsFromEnv(
  env: Pick<
    ResolvedEnv,
    "BETTERAI_ALLOWED_HOSTS" | "BETTERAI_BIND_HOST" | "BETTERAI_MCP_PORT"
  >,
): Set<string> {
  if (env.BETTERAI_ALLOWED_HOSTS) {
    return new Set(
      env.BETTERAI_ALLOWED_HOSTS.split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    );
  }
  return new Set([
    `${env.BETTERAI_BIND_HOST}:${env.BETTERAI_MCP_PORT}`,
    `localhost:${env.BETTERAI_MCP_PORT}`,
  ]);
}

// ---- Drift guards (typecheck-time; zero runtime cost) -------------------------
//
// Superset check: every key of the live ResolvedEnv must exist on the
// contract ResolvedEnv with an identical type. `Pick` itself errors if a
// live key is missing here; the mutual-assignability check errors if a
// shared key's type differs.

import type { ResolvedEnv as LiveResolvedEnv } from "../server/main.js";

export type EnvContractDriftChecks = [
  AssertTrue<
    MutuallyAssignable<Pick<ResolvedEnv, keyof LiveResolvedEnv>, LiveResolvedEnv>
  >,
];
