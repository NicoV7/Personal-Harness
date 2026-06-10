// G7 (docs/RELIABILITY-TEST-GAPS.md): RetrievalOrchestrator direct tests.
//
// The orchestrator (src/retrieval/index.ts) is the single chokepoint
// where the scope-aware context_hash is computed, the cache is consulted,
// and the audit event is emitted. Until now it was only tested transitively
// through retrieve-context.test.ts. These tests exercise it in isolation
// with REAL tmpdir corpora (no mocked filesystem, per the gap doc's
// anti-recommendations) and an injected fake audit writer.
//
// Covered:
//   - cache hit emits exactly one audit event with cache_hit: true and
//     does NOT re-invoke the RetrievalScorer
//   - cache miss emits cache_hit: false
//   - exactly ONE audit event per retrieve call, on every path
//   - scope-mode matrix: global-only / repo-only / merged, with the
//     repo-wins id-collision surfacing overridden_global_ids in the audit
//   - cache keys isolate across repo_root_detected (same query, different
//     repo root => different cache entries)
//   - null/absent repoDetector degrades to global-only without crashing
//   - adversarial inputs (empty paths, empty intent, 10KB intent) produce
//     the structured envelope — the orchestrator-level precursor of the
//     RetrieveContextResult no_match shape (src/contracts/retrieval.ts):
//     all-empty arrays that the tool layer maps to match: "none"
//   - the injected async RetrievalScorer is genuinely awaited (deferred
//     resolution still lands in both the response and the audit event)

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RetrievalOrchestrator } from "../retrieval/index.js";
import type { OrchestratorMeta, RetrieveInput } from "../retrieval/index.js";
import { DomainRouter } from "../retrieval/router.js";
import { ContextCache } from "../cache/context-hash.js";
import { RepoDetector } from "../scope/repo-detector.js";
import { GrepScorer } from "../retrieval/grep.js";
import type { AuditEvent } from "../audit/jsonl.js";
import type {
  MatchContext,
  Memory,
  RetrievalMode,
  RetrievalScorer,
  Rule,
  ScoredArtifact,
  Skill,
} from "../contracts/retrieval.js";

// ---- Fixture corpus -------------------------------------------------------

const OVERSIZED_INTENT_BYTES = 10 * 1024; // the 10KB adversarial intent

function ruleMarkdown(id: string, severity: "low" | "medium" | "high"): string {
  return `---
id: ${id}
title: Rule ${id}
category: STANDARDS
domain: naming
severity: ${severity}
created: 2026-06-09
applies_when:
  paths: ["**/*.ts"]
  intents: ["rename"]
---

## What this rule says
Use ${id}.

## Why it matters
Cost.

## When this applies
TypeScript files.

## What good looks like
\`\`\`ts
const x = 1;
\`\`\`

## Anti-patterns
Wrong.
`;
}

function writeRule(
  corpusRoot: string,
  id: string,
  severity: "low" | "medium" | "high",
): void {
  const dir = join(corpusRoot, "rules/STANDARDS/naming");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), ruleMarkdown(id, severity));
}

function scaffoldRepo(root: string, ruleIds: string[]): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "// x\n");
  for (const id of ruleIds) {
    // The colliding id is high severity so repo-wins is observable.
    writeRule(join(root, ".betterai"), id, "high");
  }
}

// ---- Scorer fakes ----------------------------------------------------------

/** Delegates to grep scoring but counts batch invocations. */
class CountingScorer implements RetrievalScorer {
  readonly mode: RetrievalMode = "grep";
  ruleCalls = 0;
  skillCalls = 0;
  memoryCalls = 0;
  private readonly inner = new GrepScorer();

  scoreRules(rules: Rule[], ctx: MatchContext): Promise<ScoredArtifact<Rule>[]> {
    this.ruleCalls += 1;
    return this.inner.scoreRules(rules, ctx);
  }
  scoreSkills(
    skills: Skill[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Skill>[]> {
    this.skillCalls += 1;
    return this.inner.scoreSkills(skills, ctx);
  }
  scoreMemories(
    memories: Memory[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Memory>[]> {
    this.memoryCalls += 1;
    return this.inner.scoreMemories(memories, ctx);
  }
}

const DEFERRED_SCORE = 7;
const DEFERRED_REASON = "deferred-batch";

/**
 * Resolves on a macrotask (setTimeout), not synchronously — a scorer whose
 * results only exist AFTER a real event-loop turn. If the orchestrator ever
 * regressed to a sync assumption (e.g. dropped an await), the fixed
 * score/reason below could not appear in the response or the audit event.
 */
class DeferredScorer implements RetrievalScorer {
  readonly mode: RetrievalMode = "grep";

  private async defer<T>(items: T[]): Promise<ScoredArtifact<T>[]> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return items.map((item) => ({
      item,
      score: DEFERRED_SCORE,
      reason: DEFERRED_REASON,
    }));
  }
  scoreRules(rules: Rule[]): Promise<ScoredArtifact<Rule>[]> {
    return this.defer(rules);
  }
  scoreSkills(skills: Skill[]): Promise<ScoredArtifact<Skill>[]> {
    return this.defer(skills);
  }
  scoreMemories(memories: Memory[]): Promise<ScoredArtifact<Memory>[]> {
    return this.defer(memories);
  }
}

// ---- Harness ----------------------------------------------------------------

describe("RetrievalOrchestrator (G7 direct tests)", () => {
  let globalRoot: string;
  let repoA: string;
  let repoB: string;
  let looseDir: string;

  beforeAll(() => {
    globalRoot = mkdtempSync(join(tmpdir(), "betterai-orch-global-"));
    repoA = mkdtempSync(join(tmpdir(), "betterai-orch-repo-a-"));
    repoB = mkdtempSync(join(tmpdir(), "betterai-orch-repo-b-"));
    looseDir = mkdtempSync(join(tmpdir(), "betterai-orch-loose-"));

    writeRule(globalRoot, "use-snake-case", "medium"); // collides with repoA
    writeRule(globalRoot, "avoid-i-prefix", "low"); // additive global-only
    scaffoldRepo(repoA, ["use-snake-case", "repo-only-tabs"]);
    scaffoldRepo(repoB, ["repo-b-spacing"]);
    writeFileSync(join(looseDir, "file.ts"), "// loose\n");
    // Non-TypeScript file: matches neither applies_when.paths nor intents.
    writeFileSync(join(looseDir, "notes.txt"), "loose notes\n");
  });

  afterAll(() => {
    for (const dir of [globalRoot, repoA, repoB, looseDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const ROUTER = () =>
    new DomainRouter({
      routers: [],
      defaults: {
        domains: ["naming"],
        max_rules_per_domain: 4,
        max_total_rules: 12,
      },
    });

  let callSeq = 0;
  function meta(): OrchestratorMeta {
    callSeq += 1;
    return {
      agent_session_id: "test-session-orch",
      parent_agent_session_id: null,
      subagent_class: "main",
      tool_call_id: `orch-call-${callSeq}`,
    };
  }

  interface HarnessOverrides {
    scorer?: RetrievalScorer;
    cache?: ContextCache;
    repoDetector?: RepoDetector | null;
  }

  function makeOrchestrator(overrides: HarnessOverrides = {}) {
    const events: AuditEvent[] = [];
    const orchestrator = new RetrievalOrchestrator({
      globalCorpusRoot: globalRoot,
      router: ROUTER(),
      cache: overrides.cache ?? new ContextCache(),
      repoDetector:
        "repoDetector" in overrides
          ? overrides.repoDetector
          : new RepoDetector({ stopAt: ["/", tmpdir()] }),
      auditLog: (e: AuditEvent) => events.push(e),
      ...(overrides.scorer ? { scorer: overrides.scorer } : {}),
    });
    return { orchestrator, events };
  }

  function repoAInput(scope?: "merged" | "global" | "repo"): RetrieveInput {
    return {
      context: {
        file_paths: [join(repoA, "src/x.ts")],
        intent: "rename a variable",
      },
      ...(scope ? { scope } : {}),
    };
  }

  // ---- Cache hit / miss + audit -------------------------------------------

  test("cache hit emits audit with cache_hit: true and does NOT re-score", async () => {
    const scorer = new CountingScorer();
    const { orchestrator, events } = makeOrchestrator({ scorer });

    const first = await orchestrator.retrieveContext(repoAInput("merged"), meta());
    expect(scorer.ruleCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].cache_hit).toBe(false);

    const second = await orchestrator.retrieveContext(repoAInput("merged"), meta());

    // Served from cache: no second scoring pass, identical payload.
    expect(scorer.ruleCalls).toBe(1);
    expect(scorer.skillCalls).toBe(1);
    expect(scorer.memoryCalls).toBe(1);
    expect(second).toEqual(first);

    expect(events).toHaveLength(2);
    expect(events[1].cache_hit).toBe(true);
    expect(events[1].event_type).toBe("retrieve");
    // The cache-hit event still reports what was served.
    expect(events[1].rules_returned.map((r) => r.id).sort()).toEqual(
      first.rules.map((r) => r.id).sort(),
    );
    expect(events[1].overridden_global_ids).toEqual(first.overridden_global_ids);
  });

  test("exactly one audit event per retrieve call, including single-kind wrappers", async () => {
    const { orchestrator, events } = makeOrchestrator();

    await orchestrator.retrieveContext(repoAInput("merged"), meta());
    expect(events).toHaveLength(1);

    // Single-kind retrievals delegate to retrieveContext — still one
    // event per CALL, never zero, never two.
    await orchestrator.retrieveRules(repoAInput("global"), meta());
    expect(events).toHaveLength(2);

    await orchestrator.retrieveSkills(repoAInput("repo"), meta());
    expect(events).toHaveLength(3);

    // Required fields present on every event, hit or miss.
    for (const e of events) {
      expect(e.event_type).toBe("retrieve");
      expect(typeof e.context_hash).toBe("string");
      expect(e.context_hash.length).toBeGreaterThan(0);
      expect(typeof e.cache_hit).toBe("boolean");
      expect(typeof e.latency_ms).toBe("number");
      expect(Array.isArray(e.scopes_queried)).toBe(true);
      expect(Array.isArray(e.rules_returned)).toBe(true);
      expect(Array.isArray(e.overridden_global_ids)).toBe(true);
      expect(e.agent_session_id).toBe("test-session-orch");
    }
  });

  // ---- Scope-mode matrix ----------------------------------------------------

  test("scope: 'global' queries only the global corpus", async () => {
    const { orchestrator, events } = makeOrchestrator();

    const out = await orchestrator.retrieveContext(repoAInput("global"), meta());

    expect(out.scopes_queried).toEqual(["global"]);
    expect(out.repo_root_detected).toBeNull();
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((r) => r.scope === "global")).toBe(true);
    // No repo corpus loaded → nothing can be overridden.
    expect(out.overridden_global_ids).toEqual([]);
    const ids = out.rules.map((r) => r.id);
    expect(ids).toContain("use-snake-case");
    expect(ids).toContain("avoid-i-prefix");
    expect(events[0].scopes_queried).toEqual(["global"]);
  });

  test("scope: 'repo' returns only repo-scoped rules", async () => {
    const { orchestrator } = makeOrchestrator();

    const out = await orchestrator.retrieveContext(repoAInput("repo"), meta());

    expect(out.scopes_queried).toEqual(["repo"]);
    expect(out.repo_root_detected).toBe(repoA);
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((r) => r.scope === "repo")).toBe(true);
    const ids = out.rules.map((r) => r.id).sort();
    expect(ids).toEqual(["repo-only-tabs", "use-snake-case"]);
  });

  test("scope: 'merged' applies repo-wins id-collision and audits overridden_global_ids", async () => {
    const { orchestrator, events } = makeOrchestrator();

    const out = await orchestrator.retrieveContext(repoAInput("merged"), meta());

    expect(out.scopes_queried).toEqual(["global", "repo"]);
    expect(out.repo_root_detected).toBe(repoA);

    // Repo wins the id collision: exactly one survivor, repo-scoped,
    // carrying the repo's severity.
    const colliding = out.rules.filter((r) => r.id === "use-snake-case");
    expect(colliding).toHaveLength(1);
    expect(colliding[0].scope).toBe("repo");
    expect(colliding[0].severity).toBe("high");

    // Additive union keeps the non-colliding global rule.
    const additive = out.rules.find((r) => r.id === "avoid-i-prefix");
    expect(additive?.scope).toBe("global");

    // The override is observable in BOTH the response and the audit event.
    expect(out.overridden_global_ids).toEqual(["use-snake-case"]);
    expect(events).toHaveLength(1);
    expect(events[0].overridden_global_ids).toEqual(["use-snake-case"]);
    expect(events[0].scopes_queried).toEqual(["global", "repo"]);
    expect(events[0].repo_root_detected).toBe(repoA);
  });

  test("cache keys isolate across repo_root_detected: same query, different repo root", async () => {
    const scorer = new CountingScorer();
    const cache = new ContextCache();
    const { orchestrator, events } = makeOrchestrator({ scorer, cache });

    const queryFor = (repoRoot: string): RetrieveInput => ({
      // Identical context except the repo root — the cross-corpus
      // poisoning case from STANDARDS/observability/context-hash-includes-scope.
      context: { intent: "rename a variable", repo_root: repoRoot },
      scope: "merged",
    });

    const fromA = await orchestrator.retrieveContext(queryFor(repoA), meta());
    const fromB = await orchestrator.retrieveContext(queryFor(repoB), meta());

    // Second call MUST be a cache miss, not a poisoned hit from repoA.
    expect(scorer.ruleCalls).toBe(2);
    expect(events.map((e) => e.cache_hit)).toEqual([false, false]);
    expect(events[0].context_hash).not.toBe(events[1].context_hash);

    expect(fromA.repo_root_detected).toBe(repoA);
    expect(fromB.repo_root_detected).toBe(repoB);
    const idsA = fromA.rules.map((r) => r.id);
    const idsB = fromB.rules.map((r) => r.id);
    expect(idsA).toContain("repo-only-tabs");
    expect(idsA).not.toContain("repo-b-spacing");
    expect(idsB).toContain("repo-b-spacing");
    expect(idsB).not.toContain("repo-only-tabs");

    // Repeating repoA's query now hits ITS cache entry — no re-score.
    const again = await orchestrator.retrieveContext(queryFor(repoA), meta());
    expect(scorer.ruleCalls).toBe(2);
    expect(events[2].cache_hit).toBe(true);
    expect(again).toEqual(fromA);
  });

  // ---- Null / absent repoDetector -------------------------------------------

  test("null repoDetector falls back to global-only without crashing", async () => {
    const { orchestrator, events } = makeOrchestrator({ repoDetector: null });

    // file_paths live inside a real repo, but with no detector wired the
    // orchestrator must degrade to global-only rather than throw.
    const out = await orchestrator.retrieveContext(repoAInput("merged"), meta());

    expect(out.repo_root_detected).toBeNull();
    expect(out.scopes_queried).toEqual(["global"]);
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((r) => r.scope === "global")).toBe(true);
    expect(out.overridden_global_ids).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].repo_root_detected).toBeNull();
  });

  test("absent repoDetector (omitted dep) also falls back to global-only", async () => {
    const events: AuditEvent[] = [];
    // No repoDetector key at all — the dep is optional by contract.
    const orchestrator = new RetrievalOrchestrator({
      globalCorpusRoot: globalRoot,
      router: ROUTER(),
      cache: new ContextCache(),
      auditLog: (e: AuditEvent) => events.push(e),
    });

    const out = await orchestrator.retrieveContext(repoAInput("merged"), meta());

    expect(out.scopes_queried).toEqual(["global"]);
    expect(out.repo_root_detected).toBeNull();
    expect(out.rules.every((r) => r.scope === "global")).toBe(true);
    expect(events).toHaveLength(1);
  });

  // ---- Adversarial inputs ----------------------------------------------------

  // The orchestrator returns the v1.0 RetrieveOutput envelope; the
  // match: "none" discriminant (RetrieveContextResult in
  // src/contracts/retrieval.ts) is layered on by the tool handler from
  // exactly this all-empty shape. So the orchestrator's contract under
  // adversarial input is: never crash, always the full structured
  // envelope, empty arrays when nothing matches.
  function expectStructuredEnvelope(out: {
    rules: unknown[];
    skills: unknown[];
    memories: unknown[];
    overridden_global_ids: string[];
    scopes_queried: unknown[];
    repo_root_detected: string | null;
  }): void {
    expect(Array.isArray(out.rules)).toBe(true);
    expect(Array.isArray(out.skills)).toBe(true);
    expect(Array.isArray(out.memories)).toBe(true);
    expect(Array.isArray(out.overridden_global_ids)).toBe(true);
    expect(Array.isArray(out.scopes_queried)).toBe(true);
    expect(out.scopes_queried.length).toBeGreaterThan(0);
  }

  test("empty paths array + empty intent: no crash, structured no-match envelope", async () => {
    const { orchestrator, events } = makeOrchestrator();

    const out = await orchestrator.retrieveContext(
      { context: { file_paths: [], intent: "" }, scope: "merged" },
      meta(),
    );

    expectStructuredEnvelope(out);
    expect(out.repo_root_detected).toBeNull();
    expect(out.scopes_queried).toEqual(["global"]);
    // Nothing can match an empty context → the no_match precursor shape.
    expect(out.rules).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.memories).toEqual([]);
    expect(out.overridden_global_ids).toEqual([]);
    // The empty retrieval is still observable: one event, empty rules.
    expect(events).toHaveLength(1);
    expect(events[0].rules_returned).toEqual([]);
  });

  test("absent context fields entirely: no crash, structured envelope", async () => {
    const { orchestrator, events } = makeOrchestrator();

    const out = await orchestrator.retrieveContext({ context: {} }, meta());

    expectStructuredEnvelope(out);
    expect(out.rules).toEqual([]);
    expect(events).toHaveLength(1);
  });

  test("oversized 10KB intent: no crash, structured envelope, single audit event", async () => {
    const { orchestrator, events } = makeOrchestrator();
    const garbage = "zq".repeat(OVERSIZED_INTENT_BYTES / 2); // 10KB, matches nothing

    const out = await orchestrator.retrieveContext(
      {
        context: { file_paths: [join(looseDir, "notes.txt")], intent: garbage },
        scope: "merged",
      },
      meta(),
    );

    expectStructuredEnvelope(out);
    expect(out.rules).toEqual([]); // garbage intent + non-matching path: no rule fires
    expect(events).toHaveLength(1);
    expect(events[0].rules_returned).toEqual([]);
    expect(typeof events[0].context_hash).toBe("string");
  });

  test("oversized intent that DOES contain a keyword still matches correctly", async () => {
    const { orchestrator } = makeOrchestrator();
    const padded =
      "rename " + "z".repeat(OVERSIZED_INTENT_BYTES); // >10KB, keyword buried up front

    const out = await orchestrator.retrieveContext(
      {
        context: { file_paths: [join(repoA, "src/x.ts")], intent: padded },
        scope: "merged",
      },
      meta(),
    );

    expectStructuredEnvelope(out);
    expect(out.rules.map((r) => r.id)).toContain("use-snake-case");
  });

  // ---- Async scorer contract ---------------------------------------------------

  test("a deferred async RetrievalScorer is awaited — its results land in response and audit", async () => {
    const { orchestrator, events } = makeOrchestrator({
      scorer: new DeferredScorer(),
    });

    const out = await orchestrator.retrieveContext(repoAInput("merged"), meta());

    // The deferred batch resolved AFTER a macrotask; its items are here.
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.map((r) => r.id).sort()).toEqual([
      "avoid-i-prefix",
      "repo-only-tabs",
      "use-snake-case",
    ]);

    // And the deferred scorer's exact scores/reasons reached the audit
    // event — impossible if the orchestrator had a sync assumption.
    expect(events).toHaveLength(1);
    expect(events[0].rules_returned.length).toBeGreaterThan(0);
    for (const entry of events[0].rules_returned) {
      expect(entry.score).toBe(DEFERRED_SCORE);
      expect(entry.reason).toBe(DEFERRED_REASON);
    }
  });
});
