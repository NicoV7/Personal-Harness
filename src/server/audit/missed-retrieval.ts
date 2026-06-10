// src/server/audit/missed-retrieval.ts
//
// Lever (b) of the auto-retrieve strategy (eng review §1.6):
//
// "A 'first-write-tool' sentinel: the MCP server records when the agent
//  calls an MCP tool that writes code; if no retrieve_* was called in the
//  last 60s with a matching context_hash, return a soft warning in the
//  response and log a 'skipped-retrieval' event."
//
// This module tracks per-session retrieval activity in memory and emits a
// `missed_retrieval` audit event when a code-writing tool fires without a
// recent retrieve_context.
//
// Memory only — restart-amnesia is fine; the audit log is the durable
// signal.  We GC sessions older than the recency window so the map can't
// grow unboundedly under churn.

import type { AuditLogFn, SubagentClass } from "./jsonl.js";
import {
  MISSED_RETRIEVAL_RECENCY_MS,
  MISSED_RETRIEVAL_SESSION_GC_MS,
} from "../../constants/audit.js";

/**
 * Tools the agent calls that are read-only and should *not* require a
 * prior retrieval (e.g. retrieve_context itself is meta — we record it
 * here as a retrieval, not check it).
 */
const RETRIEVAL_TOOL_NAMES = new Set([
  "retrieve_context",
  "retrieve_rules",
  "retrieve_skills",
  "retrieve_memories",
]);

/**
 * Tools that materially produce or modify code/decisions and therefore
 * "should have been preceded by a retrieve_context" in the same session.
 *
 * Phase 1.0 only check_file (the inline-content variant is the one the
 * agent calls before writing to disk); record_memory is also a write but
 * is not code itself — left out to avoid noise.  Extend as the tool
 * surface grows.
 */
const CODE_WRITING_TOOL_NAMES = new Set(["check_file"]);

interface SessionState {
  lastRetrievalAtMs: number;
  lastRetrievalHash: string | null;
}

export interface MissedRetrievalOptions {
  /** How recently a retrieve_* must have fired to count as "covered". */
  recencyMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface ObserveCallInput {
  toolName: string;
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: SubagentClass | null;
  tool_call_id: string;
  context_hash: string;
  repo_root_detected: string | null;
  scopes_queried: ("global" | "repo")[];
}

export class MissedRetrievalDetector {
  private readonly sessions = new Map<string, SessionState>();
  private readonly recencyMs: number;
  private readonly now: () => number;

  constructor(
    private readonly auditLog: AuditLogFn,
    opts: MissedRetrievalOptions = {},
  ) {
    this.recencyMs = opts.recencyMs ?? MISSED_RETRIEVAL_RECENCY_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record an MCP tool call.  Two outcomes:
   *   1. retrieval-class tool → stamp the session's lastRetrievalAtMs.
   *   2. code-writing tool with no recent retrieval → emit a
   *      `missed_retrieval` audit event.
   */
  observe(call: ObserveCallInput): { missed: boolean } {
    const key = call.agent_session_id ?? "__no_session__";
    const now = this.now();
    this.gc(now);

    if (RETRIEVAL_TOOL_NAMES.has(call.toolName)) {
      this.sessions.set(key, {
        lastRetrievalAtMs: now,
        lastRetrievalHash: call.context_hash,
      });
      return { missed: false };
    }

    if (!CODE_WRITING_TOOL_NAMES.has(call.toolName)) {
      return { missed: false };
    }

    const session = this.sessions.get(key);
    const covered =
      session && now - session.lastRetrievalAtMs <= this.recencyMs;

    if (covered) return { missed: false };

    this.auditLog({
      event_type: "missed_retrieval",
      ts: new Date(now).toISOString(),
      agent_session_id: call.agent_session_id,
      parent_agent_session_id: call.parent_agent_session_id,
      subagent_class: call.subagent_class,
      tool_call_id: call.tool_call_id,
      context_hash: call.context_hash,
      repo_root_detected: call.repo_root_detected,
      scopes_queried: call.scopes_queried,
      rules_returned: [],
      overridden_global_ids: [],
      latency_ms: 0,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    });

    return { missed: true };
  }

  private gc(nowMs: number): void {
    // The GC threshold must never undercut the coverage window: with a
    // configured recencyMs longer than SESSION_GC_MS, sweeping at the
    // 5-minute floor would delete still-covered sessions and emit FALSE
    // missed_retrieval events.
    const gcMs = Math.max(MISSED_RETRIEVAL_SESSION_GC_MS, this.recencyMs);
    for (const [k, v] of this.sessions) {
      if (nowMs - v.lastRetrievalAtMs > gcMs) this.sessions.delete(k);
    }
  }
}
