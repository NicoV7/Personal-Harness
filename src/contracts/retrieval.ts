// src/contracts/retrieval.ts
//
// SHARED CONTRACT — retrieval shapes (schema_version 1.5).
//
// Mirrors the LIVE shapes in src/server/retrieve/grep.ts and
// src/server/retrieve/index.ts; drift guards at the bottom fail
// `npm run typecheck` on any divergence.
//
// PLUS the NEW `RetrievalScorer` seam that the Phase-1.5 embeddings
// specialist implements (Wave 3+). The grep scorer, the MiniLM embedding
// scorer, and the hybrid scorer all satisfy the same interface so the
// orchestrator never changes when retrieval mode does.

import type { Scope } from "./audit.js";
import type { AssertTrue, MutuallyAssignable } from "./audit.js";

// Rule / Skill / Memory stay defined in the corpus reader for now (the
// frontmatter Zod schemas live there); re-exported type-only so contract
// consumers have a single import surface. Contract-ifying the corpus
// shapes is a later-wave item.
export type { Memory, Rule, Skill } from "../server/corpus/reader.js";
import type { Memory, Rule, Skill } from "../server/corpus/reader.js";

// ---- Matching ------------------------------------------------------------

export interface MatchContext {
  file_paths: string[];
  intent: string;
  symbols: string[];
  recent_diff: string;
}

export interface ScoredArtifact<T> {
  item: T;
  score: number;
  reason: string;
}

// ---- Orchestrator I/O -----------------------------------------------------

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

// ---- Structured no-match (G5-M1, NEW in v1.5) ------------------------------

/**
 * Echo of the query the server actually evaluated (post-normalization),
 * so an agent that hit `match: "none"` can see exactly what was searched
 * and decide how to rephrase — without diffing its own call site.
 */
export interface QueryEcho {
  intent: string;
  file_paths: string[];
  symbols: string[];
}

/**
 * G5-M1 fault-tolerance mode: "search returns nothing" must be a
 * FIRST-CLASS structured response, not bare empty arrays — agents
 * branch on `match` explicitly instead of inferring emptiness.
 *
 * Discriminant semantics:
 *   - `match: "matched"`  — at least one rule, skill, or memory returned.
 *   - `match: "none"`     — zero artifacts across every kind; `reason`
 *     and `query_echo` are present so the agent can report or retry.
 *
 * The empty arrays are still present alongside (additive extension of
 * the v1.0 output shape) so existing consumers keep working. The audit
 * event is emitted either way, with `rules_returned: []` on no-match.
 */
export type RetrieveMatchInfo =
  | { match: "matched" }
  | { match: "none"; reason: "no_match"; query_echo: QueryEcho };

/** The retrieve_context tool's full output: v1.0 lists + match discriminant. */
export type RetrieveContextResult = RetrieveOutput & RetrieveMatchInfo;

// ---- The retrieval-scorer seam (NEW in v1.5) ------------------------------

export const RETRIEVAL_MODES = ["grep", "embedding", "hybrid"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * Async batch scoring seam between the orchestrator and the matching
 * strategy. Phase 1.0 ships a grep implementation (wrapping
 * src/server/retrieve/grep.ts scoreRule/scoreSkill/scoreMemory); the
 * Wave-3 embeddings specialist adds a MiniLM implementation and a
 * hybrid that blends both. The orchestrator selects an implementation
 * from BETTERAI_RETRIEVAL_MODE (see src/contracts/env.ts) and never
 * branches on the mode itself.
 *
 * DETERMINISM REQUIREMENT (cache-key safety): for a fixed corpus
 * snapshot and a fixed MatchContext, implementations MUST return the
 * same scores, the same ordering, and the same reason strings on every
 * call. Retrieval results are cached under a context_hash that does NOT
 * include scorer-internal state — a nondeterministic scorer would make
 * cache hits diverge from cold reads and poison the audit trail
 * (.betterai/rules/STANDARDS/observability/context-hash-includes-scope.md).
 * Concretely: no Math.random, no wall-clock-dependent scoring, no
 * unseeded ANN search, and embedding lookups must be content-addressed.
 *
 * Batch + async by design: embedding scorers want one model invocation
 * per batch, not per artifact, and the model call is async. The grep
 * implementation simply resolves synchronously computed scores.
 */
export interface RetrievalScorer {
  scoreRules(rules: Rule[], ctx: MatchContext): Promise<ScoredArtifact<Rule>[]>;
  scoreSkills(
    skills: Skill[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Skill>[]>;
  scoreMemories(
    memories: Memory[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Memory>[]>;
  /** Which strategy this scorer implements; echoed into observability. */
  readonly mode: RetrievalMode;
}

// ---- Drift guards (typecheck-time; zero runtime cost) ---------------------

import type {
  MatchContext as LiveMatchContext,
  ScoredArtifact as LiveScoredArtifact,
} from "../server/retrieve/grep.js";
import type {
  RetrieveInput as LiveRetrieveInput,
  RetrieveOutput as LiveRetrieveOutput,
  ScopeFilter as LiveScopeFilter,
} from "../server/retrieve/index.js";

export type RetrievalContractDriftChecks = [
  AssertTrue<MutuallyAssignable<MatchContext, LiveMatchContext>>,
  AssertTrue<
    MutuallyAssignable<ScoredArtifact<Rule>, LiveScoredArtifact<Rule>>
  >,
  AssertTrue<
    MutuallyAssignable<ScoredArtifact<Memory>, LiveScoredArtifact<Memory>>
  >,
  AssertTrue<MutuallyAssignable<RetrieveInput, LiveRetrieveInput>>,
  AssertTrue<MutuallyAssignable<RetrieveOutput, LiveRetrieveOutput>>,
  AssertTrue<MutuallyAssignable<ScopeFilter, LiveScopeFilter>>,
];
