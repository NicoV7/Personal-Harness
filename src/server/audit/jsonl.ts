// src/server/audit/jsonl.ts
//
// Append-only JSONL audit writer with rotation.
//
// Rotation: when the active file exceeds 100 MB OR is older than 30 days,
// we rename it to audit-<ISO>.jsonl and open a fresh audit.jsonl.
//
// Per .betterai/rules/STANDARDS/observability/audit-must-include-parent-session:
//   if subagent_class !== "main" then parent_agent_session_id MUST NOT be null.
//   The validator throws AuditValidationError at emit time — silent drops
//   cost more than a noisy crash.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  AUDIT_FILE_MODE,
  AUDIT_MAX_AGE_MS,
  AUDIT_MAX_BYTES,
} from "../../constants/audit.js";

export type SubagentClass =
  | "main"
  | "agent-tool"
  | "workflow"
  | "background"
  | "cron";

export type AuditEventType =
  | "retrieve"
  | "explain"
  | "check"
  | "rule_change"
  | "agent_apply"
  | "missed_retrieval"
  | "memory_recorded";

export type Scope = "global" | "repo";

export type ArtifactKind = "rule" | "skill" | "memory";

export interface AuditEventRuleEntry {
  id: string;
  kind: ArtifactKind;
  scope: Scope;
  domain: string;
  score: number;
  reason: string;
}

export interface AuditEvent {
  event_type: AuditEventType;
  ts: string; // ISO timestamp
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: SubagentClass | null;
  tool_call_id: string;
  context_hash: string;
  repo_root_detected: string | null;
  scopes_queried: Scope[];
  rules_returned: AuditEventRuleEntry[];
  overridden_global_ids: string[];
  latency_ms: number;
  /**
   * Whether the retrieval was served from the in-memory cache.
   * Optional — populated by tools on cache-served retrievals; absent on
   * misses and on non-retrieve events. The downstream validator treats
   * it as additive and ignores it for the parent-session invariant.
   */
  cache_hit?: boolean;
  // v2 self-learning fields — reserved, always null in v1.
  downstream_apply_event_id: null;
  downstream_commit_sha: null;
  downstream_violations: null;
}

// AuditValidationError (BAI-502) and AuditIoError (BAI-501) now live in the
// central errors layer per typed-errors-from-errors-layer. Both preserve their
// observable shapes: AuditValidationError keeps `.name === "AuditValidationError"`;
// AuditIoError keeps the errno string on `.code`, the audit path on `.path`,
// and the original errno error on `.cause`. Re-exported so existing importers
// (this module, the audit-writer-io tests) are unchanged.
export { AuditIoError, AuditValidationError } from "../../errors/index.js";
import { AuditIoError, AuditValidationError } from "../../errors/index.js";

/**
 * Validate the parent-session invariant.  Called from `append` so no
 * caller can bypass it.  Returns the event unchanged on success.
 */
export function validateAuditEvent(event: AuditEvent): void {
  if (event.subagent_class && event.subagent_class !== "main") {
    if (!event.parent_agent_session_id) {
      throw new AuditValidationError(
        `subagent audit event (class=${event.subagent_class}) must set parent_agent_session_id`,
      );
    }
  }
}

export interface AuditWriterOptions {
  /** Absolute path to the active JSONL file. */
  path: string;
  /** Rotation byte threshold; default 100 MB. */
  maxBytes?: number;
  /** Rotation age threshold; default 30 days. */
  maxAgeMs?: number;
  /** Clock injection point for tests. */
  now?: () => Date;
}

export class JsonlAuditWriter {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  /**
   * Whether the parent directory has been ensured on disk. Flipped on
   * first append so construction never touches the filesystem — the
   * server-boot tests run with BETTERAI_AUDIT_PATH defaulting to
   * /data/audit/audit.jsonl which the test process can't mkdir, and a
   * lazy mkdir means simply constructing the writer (e.g. inside
   * startServer) doesn't blow up.
   */
  private _dirInitialized = false;

  constructor(opts: AuditWriterOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? AUDIT_MAX_AGE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * FAILURE CONTRACT (decided for G3, docs/RELIABILITY-TEST-GAPS.md):
   * `append` THROWS a typed `AuditIoError` on any filesystem failure —
   * it never degrades to a stderr warning, never buffers, never drops.
   *
   * Why throw-on-append instead of throw-at-construction or
   * degrade-with-a-failed-flag:
   *   - Construction must stay filesystem-free (the lazy `_dirInitialized`
   *     design below): server-boot tests construct the writer with a
   *     default /data path the test process cannot mkdir, and `startServer`
   *     must not blow up before the transport is even bound.
   *   - Degrading silently is the one unacceptable outcome: the audit log
   *     is BetterAI's ONLY observability surface, so a swallowed append is
   *     a blackholed compliance trail.  A thrown AuditIoError propagates
   *     out of the tool handler, the MCP call fails loudly, and the agent
   *     (or its parent) sees the failure instead of a normal-looking
   *     success with a silently-missing audit event.
   *
   * RECOVERY SEMANTICS:
   *   - Parent dir removed mid-run (ENOENT): we re-run the lazy mkdir and
   *     retry the append exactly once.  Only if recovery also fails does
   *     the typed error surface.  No events are lost on a recoverable
   *     dir-removal.
   *   - Audit file rotated/renamed/deleted externally mid-run: the next
   *     append simply recreates a fresh file at the configured path
   *     (O_APPEND creates on absence) — subsequent events land in the new
   *     file, none are lost.
   */
  append(event: AuditEvent): void {
    validateAuditEvent(event);
    const line = JSON.stringify(event) + "\n";
    try {
      this.writeLine(line);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Parent dir vanished after a previous successful append.
        // Lazy-mkdir recovery: reset the init flag and retry once.
        this._dirInitialized = false;
        try {
          this.writeLine(line);
          return;
        } catch (retryErr) {
          throw this.wrapIoError(retryErr);
        }
      }
      throw this.wrapIoError(err);
    }
  }

  /** ensureDir + EISDIR guard + rotation + append + mode enforcement. */
  private writeLine(line: string): void {
    this.ensureDir();
    // Guard the misconfiguration hit live on 2026-06-10: BETTERAI_AUDIT_PATH
    // pointing at an EXISTING DIRECTORY.  appendFileSync would die with a
    // raw EISDIR; surface a typed, actionable error instead.
    const existedBefore = existsSync(this.path);
    if (existedBefore && statSync(this.path).isDirectory()) {
      throw new AuditIoError(
        `audit path ${this.path} is a directory — BETTERAI_AUDIT_PATH must point at a .jsonl FILE (e.g. ${this.path}/audit.jsonl)`,
        { path: this.path },
      );
    }
    this.rotateIfNeeded();
    const createsFile = !existsSync(this.path);
    appendFileSync(this.path, line, { mode: AUDIT_FILE_MODE });
    if (createsFile) {
      // appendFileSync's `mode` is masked by the process umask; enforce
      // the exact 0o640 contract on every freshly created file.
      chmodSync(this.path, AUDIT_FILE_MODE);
    }
  }

  private wrapIoError(err: unknown): Error {
    if (err instanceof AuditIoError || err instanceof AuditValidationError) {
      return err;
    }
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return new AuditIoError(
      `audit append to ${this.path} failed (${code}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { path: this.path, cause: err },
    );
  }

  private ensureDir(): void {
    if (this._dirInitialized) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this._dirInitialized = true;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    const st = statSync(this.path);
    const tooBig = st.size >= this.maxBytes;
    const tooOld = this.now().getTime() - st.mtimeMs >= this.maxAgeMs;
    if (!tooBig && !tooOld) return;
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const rotated = this.path.replace(/\.jsonl$/, `-${stamp}.jsonl`);
    renameSync(this.path, rotated);
  }
}

/**
 * Convenience type for the dependency-injected emitter that handlers
 * receive.  Handlers should never write to disk directly; they call
 * `ctx.auditLog(event)` and the writer takes care of validation +
 * rotation + serialization.
 */
export type AuditLogFn = (event: AuditEvent) => void;
// trivial change to test the docs hook
