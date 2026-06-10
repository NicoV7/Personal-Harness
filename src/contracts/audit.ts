// src/contracts/audit.ts
//
// SHARED CONTRACT — audit event shapes (schema_version 1.5).
//
// This module is the single source of truth that ALL wave specialists
// import. It exists to prevent the Wave-3 failure mode: teams agreeing
// on shapes in their prompts but each implementing the agreement
// differently (docs/HANDOFF.md §"What NOT to do").
//
// The Zod schemas here mirror the LIVE shapes in src/server/audit/jsonl.ts
// exactly. Drift guards at the bottom of this file make `npm run
// typecheck` fail if either side diverges — the import-flip (server
// importing these contracts instead of defining its own) happens
// incrementally in later waves; until then both definitions coexist and
// the guards keep them bit-identical.
//
// Locked invariants (don't re-litigate; see docs/HANDOFF.md §"The locked
// schema" and .betterai/rules/STANDARDS/observability/*):
//   - subagent_class != "main" REQUIRES non-null parent_agent_session_id.
//   - context_hash includes scope + repo_root (cache-poisoning guard).
//   - downstream_* fields are reserved for v2 self-learning; always null.

import { z } from "zod";

// ---- Type-level drift helpers (shared by all contract modules) ---------

/**
 * `true` iff A and B are mutually assignable (bidirectional structural
 * compatibility). Tuple wrapping prevents union distribution.
 */
export type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** Compile-time assertion: the instantiation errors unless T is `true`. */
export type AssertTrue<T extends true> = T;

// ---- Enumerations -------------------------------------------------------

export const SUBAGENT_CLASSES = [
  "main",
  "agent-tool",
  "workflow",
  "background",
  "cron",
] as const;

export const SubagentClassSchema = z.enum(SUBAGENT_CLASSES);
export type SubagentClass = z.infer<typeof SubagentClassSchema>;

export const AUDIT_EVENT_TYPES = [
  "retrieve",
  "explain",
  "check",
  "rule_change",
  "agent_apply",
  "missed_retrieval",
  "memory_recorded",
] as const;

export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const SCOPES = ["global", "repo"] as const;

export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const ARTIFACT_KINDS = ["rule", "skill", "memory"] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// ---- Per-item audit entry -----------------------------------------------

export const AuditEventRuleEntrySchema = z.object({
  id: z.string(),
  kind: ArtifactKindSchema,
  scope: ScopeSchema,
  domain: z.string(),
  score: z.number(),
  reason: z.string(),
});
export type AuditEventRuleEntry = z.infer<typeof AuditEventRuleEntrySchema>;

// ---- The audit event envelope -------------------------------------------

export const AuditEventSchema = z.object({
  event_type: AuditEventTypeSchema,
  /** ISO timestamp. */
  ts: z.string(),
  agent_session_id: z.string().nullable(),
  parent_agent_session_id: z.string().nullable(),
  subagent_class: SubagentClassSchema.nullable(),
  tool_call_id: z.string(),
  context_hash: z.string(),
  repo_root_detected: z.string().nullable(),
  scopes_queried: z.array(ScopeSchema),
  rules_returned: z.array(AuditEventRuleEntrySchema),
  overridden_global_ids: z.array(z.string()),
  latency_ms: z.number(),
  /**
   * Whether the retrieval was served from the in-memory cache.
   * Optional — populated by tools on cache-served retrievals; absent on
   * misses and on non-retrieve events.
   */
  cache_hit: z.boolean().optional(),
  // v2 self-learning fields — reserved, always null in v1.
  downstream_apply_event_id: z.null(),
  downstream_commit_sha: z.null(),
  downstream_violations: z.null(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---- Drift guards (typecheck-time; zero runtime cost) -------------------
//
// These import the LIVE server types (type-only, fully erased at compile)
// and assert bidirectional assignability. If either side changes shape,
// `npm run typecheck` fails right here.

import type {
  AuditEvent as LiveAuditEvent,
  AuditEventRuleEntry as LiveAuditEventRuleEntry,
  AuditEventType as LiveAuditEventType,
  ArtifactKind as LiveArtifactKind,
  Scope as LiveScope,
  SubagentClass as LiveSubagentClass,
} from "../server/audit/jsonl.js";

export type AuditContractDriftChecks = [
  AssertTrue<MutuallyAssignable<AuditEvent, LiveAuditEvent>>,
  AssertTrue<MutuallyAssignable<AuditEventRuleEntry, LiveAuditEventRuleEntry>>,
  AssertTrue<MutuallyAssignable<AuditEventType, LiveAuditEventType>>,
  AssertTrue<MutuallyAssignable<ArtifactKind, LiveArtifactKind>>,
  AssertTrue<MutuallyAssignable<Scope, LiveScope>>,
  AssertTrue<MutuallyAssignable<SubagentClass, LiveSubagentClass>>,
];
