// src/server/retrieve/index.ts
//
// The merged retrieval orchestrator: query global + repo, apply override
// semantics, rank, return.
//
// Per v4.1-scoping-extension §3:
//   1. Run domain-router + grep retrieval independently against both
//      corpora.  (CorpusReader has already done the id-collision merge,
//      so we work off a single merged list; the per-item `scope` field
//      preserves origin.)
//   2. Build a merged candidate set.
//   3. Id-collision rule already applied at corpus-load time → the
//      `overridden_global_ids` list comes from the reader.
//   4. Ranking: severity × match-strength × recency.  Repo gets NO
//      automatic boost — id-collision is the only override mechanism.
//
// The orchestrator is the single chokepoint where:
//   - the scope-aware context_hash is computed
//   - the cache is consulted
//   - the audit event is built and emitted
// so handlers don't reinvent any of that.

import type { Memory, Rule, Scope, Skill } from "../corpus/reader.js";
import { CorpusReader } from "../corpus/reader.js";
import type { ContextCache } from "../cache/context-hash.js";
import { contextHash } from "../cache/context-hash.js";
import type {
  AuditLogFn,
  AuditEventRuleEntry,
  SubagentClass,
} from "../audit/jsonl.js";
import { DomainRouter } from "./router.js";
import {
  capByDomain,
  capTopK,
  GrepScorer,
  type MatchContext,
} from "./grep.js";
import type { RetrievalScorer } from "../../contracts/retrieval.js";
import type { RepoDetector } from "../scope/repo-detector.js";

export type ScopeFilter = "merged" | "global" | "repo";

export interface RetrieveInput {
  context: {
    file_paths?: string[];
    intent?: string;
    symbols?: string[];
    recent_diff?: string;
    /**
     * Explicit repo root override.  If omitted, the orchestrator runs
     * the walk-up detector against `file_paths[0]`.
     */
    repo_root?: string;
  };
  top_k_per_kind?: number;
  top_k?: number; // for single-kind tools
  scope?: ScopeFilter;
}

export interface RetrieveOutput {
  rules: Rule[];
  skills: Skill[];
  memories: Memory[];
  overridden_global_ids: string[];
  scopes_queried: Scope[];
  repo_root_detected: string | null;
}

export interface OrchestratorMeta {
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: SubagentClass | null;
  tool_call_id: string;
}

export interface RetrievalDeps {
  globalCorpusRoot: string;
  router: DomainRouter;
  cache: ContextCache;
  repoDetector: RepoDetector;
  auditLog: AuditLogFn;
  /**
   * Matching strategy behind the async-batch RetrievalScorer seam
   * (src/contracts/retrieval.ts).  src/server/main.ts selects one from
   * BETTERAI_RETRIEVAL_MODE; omitted → grep (Phase 1.0 behavior).
   */
  scorer?: RetrievalScorer;
}

/**
 * The retrieval orchestrator.  Owns the cache lookup, the corpus read,
 * the scoring, the cap, the audit emit.  Tool handlers call this and
 * shape the response — they do not duplicate any of the orchestration
 * logic.
 */
export class RetrievalOrchestrator {
  private readonly scorer: RetrievalScorer;

  constructor(private readonly deps: RetrievalDeps) {
    this.scorer = deps.scorer ?? new GrepScorer();
  }

  async retrieveContext(
    input: RetrieveInput,
    meta: OrchestratorMeta,
  ): Promise<RetrieveOutput> {
    const t0 = Date.now();
    const scope = input.scope ?? "merged";
    const ctx = normalizeContext(input);
    const repo = this.detectRepo(ctx, input.context.repo_root, scope);
    const scopes_queried: Scope[] =
      scope === "global"
        ? ["global"]
        : scope === "repo"
        ? ["repo"]
        : repo.repo_root && repo.has_betterai_dir
        ? ["global", "repo"]
        : ["global"];

    const hashable = {
      file_paths: ctx.file_paths,
      intent: ctx.intent,
      symbols: ctx.symbols,
      recent_diff: ctx.recent_diff,
      repo_root_detected: repo.repo_root,
      scopes_queried,
    };
    const key = contextHash(hashable);

    const cached = this.deps.cache.get<RetrieveOutput>(key);
    if (cached) {
      this.emitAudit(meta, key, {
        event_type: "retrieve",
        latency_ms: Date.now() - t0,
        rules: cached.payload.rules.map((r) => ({
          id: r.id,
          kind: "rule" as const,
          scope: r.scope,
          domain: r.domain,
          score: 0,
          reason: "cache_hit",
        })),
        scopes_queried,
        repo_root_detected: repo.repo_root,
        overridden_global_ids: cached.payload.overridden_global_ids,
      });
      return cached.payload;
    }

    const reader = new CorpusReader({
      globalRoot: this.deps.globalCorpusRoot,
      repoRoot:
        scopes_queried.includes("repo") && repo.repo_root
          ? `${repo.repo_root}/.betterai`
          : null,
    });
    const snapshot = reader.read();

    // Filter by scope when the caller asked for a single scope.
    const rulesPool = filterByScope(snapshot.rules, scope);
    const skillsPool = filterByScope(snapshot.skills, scope);
    const memoriesPool = filterByScope(snapshot.memories, scope);

    const route = this.deps.router.route({
      file_paths: ctx.file_paths,
      intent: ctx.intent,
    });

    // Async batch scoring through the RetrievalScorer seam — grep,
    // embedding, or hybrid per BETTERAI_RETRIEVAL_MODE; the orchestrator
    // never branches on the mode.
    const ruleScored = await this.scorer.scoreRules(rulesPool, ctx);
    const cappedRules = capByDomain(
      ruleScored,
      route.domains,
      route.max_rules_per_domain,
      input.top_k_per_kind ?? route.max_total_rules,
    );
    const topKKind =
      input.top_k_per_kind ?? Math.max(4, Math.floor(route.max_total_rules / 3));
    const cappedSkills = capTopK(
      await this.scorer.scoreSkills(skillsPool, ctx),
      topKKind,
    );
    const cappedMemories = capTopK(
      await this.scorer.scoreMemories(memoriesPool, ctx),
      topKKind,
    );

    const output: RetrieveOutput = {
      rules: cappedRules.map((s) => s.item),
      skills: cappedSkills.map((s) => s.item),
      memories: cappedMemories.map((s) => s.item),
      overridden_global_ids: snapshot.overridden_global_ids,
      scopes_queried,
      repo_root_detected: repo.repo_root,
    };

    this.deps.cache.set(key, {
      payload: output,
      scopes_queried,
      repo_root_detected: repo.repo_root,
      overridden_global_ids: snapshot.overridden_global_ids,
      cached_at_ms: Date.now(),
    });

    const auditRules: AuditEventRuleEntry[] = cappedRules.map((s) => ({
      id: s.item.id,
      kind: "rule",
      scope: s.item.scope,
      domain: s.item.domain,
      score: s.score,
      reason: s.reason,
    }));

    this.emitAudit(meta, key, {
      event_type: "retrieve",
      latency_ms: Date.now() - t0,
      rules: auditRules.length
        ? auditRules
        : cappedRules.map((s) => ({
            id: s.item.id,
            kind: "rule" as const,
            scope: s.item.scope,
            domain: s.item.domain,
            score: s.score,
            reason: s.reason,
          })),
      scopes_queried,
      repo_root_detected: repo.repo_root,
      overridden_global_ids: snapshot.overridden_global_ids,
    });

    return output;
  }

  /**
   * Single-kind retrievals share the same orchestration; we just pluck
   * the relevant list out.
   */
  async retrieveRules(
    input: RetrieveInput,
    meta: OrchestratorMeta,
  ): Promise<{ items: Rule[]; overridden_global_ids: string[] }> {
    const out = await this.retrieveContext(input, meta);
    return {
      items: out.rules.slice(0, input.top_k ?? out.rules.length),
      overridden_global_ids: out.overridden_global_ids,
    };
  }

  async retrieveSkills(
    input: RetrieveInput,
    meta: OrchestratorMeta,
  ): Promise<{ items: Skill[]; overridden_global_ids: string[] }> {
    const out = await this.retrieveContext(input, meta);
    return {
      items: out.skills.slice(0, input.top_k ?? out.skills.length),
      overridden_global_ids: out.overridden_global_ids,
    };
  }

  async retrieveMemories(
    input: RetrieveInput,
    meta: OrchestratorMeta,
  ): Promise<{ items: Memory[]; overridden_global_ids: string[] }> {
    const out = await this.retrieveContext(input, meta);
    return {
      items: out.memories.slice(0, input.top_k ?? out.memories.length),
      overridden_global_ids: out.overridden_global_ids,
    };
  }

  /**
   * Look up a single rule by id from the merged snapshot — used by
   * `explain_rule`.  No cache; this is rare and the corpus read is
   * cheap.
   */
  explainRule(
    rule_id: string,
    repoHint?: string,
  ): Rule | undefined {
    const detection = repoHint
      ? this.deps.repoDetector.detect(repoHint)
      : { repo_root: null, has_betterai_dir: false, git_head_mtime_ms: null };
    const reader = new CorpusReader({
      globalRoot: this.deps.globalCorpusRoot,
      repoRoot:
        detection.repo_root && detection.has_betterai_dir
          ? `${detection.repo_root}/.betterai`
          : null,
    });
    const snapshot = reader.read();
    return reader.findRule(snapshot, rule_id);
  }

  private detectRepo(
    ctx: MatchContext,
    explicitRoot: string | undefined,
    scope: ScopeFilter,
  ): { repo_root: string | null; has_betterai_dir: boolean } {
    if (scope === "global") {
      return { repo_root: null, has_betterai_dir: false };
    }
    if (explicitRoot) {
      const det = this.deps.repoDetector.detect(explicitRoot);
      return {
        repo_root: det.repo_root ?? explicitRoot,
        has_betterai_dir: det.has_betterai_dir,
      };
    }
    if (!ctx.file_paths.length) {
      return { repo_root: null, has_betterai_dir: false };
    }
    const det = this.deps.repoDetector.detectFromBatch(ctx.file_paths);
    return { repo_root: det.repo_root, has_betterai_dir: det.has_betterai_dir };
  }

  private emitAudit(
    meta: OrchestratorMeta,
    context_hash: string,
    args: {
      event_type: "retrieve";
      latency_ms: number;
      rules: AuditEventRuleEntry[];
      scopes_queried: Scope[];
      repo_root_detected: string | null;
      overridden_global_ids: string[];
    },
  ): void {
    this.deps.auditLog({
      event_type: args.event_type,
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash,
      repo_root_detected: args.repo_root_detected,
      scopes_queried: args.scopes_queried,
      rules_returned: args.rules,
      overridden_global_ids: args.overridden_global_ids,
      latency_ms: args.latency_ms,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    });
  }
}

function normalizeContext(input: RetrieveInput): MatchContext {
  return {
    file_paths: input.context.file_paths ?? [],
    intent: input.context.intent ?? "",
    symbols: input.context.symbols ?? [],
    recent_diff: input.context.recent_diff ?? "",
  };
}

function filterByScope<T extends { scope: Scope }>(
  items: T[],
  scope: ScopeFilter,
): T[] {
  if (scope === "merged") return items;
  return items.filter((i) => i.scope === scope);
}
