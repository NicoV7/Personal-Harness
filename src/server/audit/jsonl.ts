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
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

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
  // v2 self-learning fields — reserved, always null in v1.
  downstream_apply_event_id: null;
  downstream_commit_sha: null;
  downstream_violations: null;
}

export class AuditValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuditValidationError";
  }
}

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  constructor(opts: AuditWriterOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
    this.now = opts.now ?? (() => new Date());
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(event: AuditEvent): void {
    validateAuditEvent(event);
    this.rotateIfNeeded();
    appendFileSync(this.path, JSON.stringify(event) + "\n", { mode: 0o640 });
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
