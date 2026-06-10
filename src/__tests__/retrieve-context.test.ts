// Integration test for the retrieve_context MCP tool against REAL tmpdir
// corpora, driven through a REAL RetrievalOrchestrator (no mocked reader,
// no mocked cache — the same wiring src/server/main.ts builds).
//
// Contract per docs/design/v4.1-scoping-extension.md §3 (merge + id-collision
// override) plus the G5-M1 structured no-match shape
// (src/contracts/retrieval.ts RetrieveMatchInfo).
//
// REGRESSION (live-verification bug, 2026-06-10): the tool used to hand-roll
// retrieval against the DI singleton CorpusReader, which main.ts constructs
// with ONLY globalRoot — so repo-scope artifacts could NEVER be returned
// while the output still reported scopes_queried: ["global","repo"]. The
// tool now delegates to ctx.orchestrator, which builds a per-call reader
// with the correct repoRoot and gates scopes_queried on the repo corpus
// actually being readable (has_betterai_dir). The tests below pin:
//   - a repo-only rule IS returned when <repo>/.betterai exists
//   - scopes_queried includes "repo" ONLY when the repo corpus is readable
//   - exactly ONE audit event per call (the orchestrator's, never a second)
//   - cache_hit: true on repeat, identical payload
//   - the G5-M1 no-match shape

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import retrieveContext from "../mcp-tools/retrieve-context.js";
import type { ToolContext, ToolCallMeta } from "../server/main.js";
import { RetrievalOrchestrator } from "../server/retrieve/index.js";
import { DomainRouter } from "../server/retrieve/router.js";
import { ContextCache } from "../server/cache/context-hash.js";
import { RepoDetector } from "../server/scope/repo-detector.js";
import type { AuditEvent } from "../server/audit/jsonl.js";

// Loose view of the tool's output union so tests don't fight TS narrowing.
interface RetrieveContextOut {
  rules: Array<{ id: string; scope: "global" | "repo"; severity: string }>;
  skills: Array<{ id: string; scope: "global" | "repo" }>;
  memories: Array<{ id: string; scope: "global" | "repo" }>;
  overridden_global_ids: string[];
  scopes_queried: Array<"global" | "repo">;
  repo_root_detected: string | null;
  match?: "matched" | "none";
  reason?: "no_match";
  query_echo?: { intent: string; file_paths: string[]; symbols: string[] };
}

const RULE_TEMPLATE = (id: string, severity: string) => `---
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

function writeRule(corpusRoot: string, id: string, severity: string): void {
  const dir = join(corpusRoot, "rules/STANDARDS/naming");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), RULE_TEMPLATE(id, severity));
}

describe("retrieve_context through a real RetrievalOrchestrator", () => {
  let globalRoot: string;
  let emptyGlobalRoot: string;
  let repoRoot: string; // git repo WITH a .betterai corpus
  let bareRepoRoot: string; // git repo WITHOUT a .betterai corpus
  let looseDir: string; // not a git repo at all

  beforeAll(() => {
    globalRoot = mkdtempSync(join(tmpdir(), "betterai-global-"));
    emptyGlobalRoot = mkdtempSync(join(tmpdir(), "betterai-empty-global-"));
    repoRoot = mkdtempSync(join(tmpdir(), "betterai-repo-"));
    bareRepoRoot = mkdtempSync(join(tmpdir(), "betterai-bare-repo-"));
    looseDir = mkdtempSync(join(tmpdir(), "betterai-loose-"));

    // Global corpus: the colliding id + an additive-only id.
    writeRule(globalRoot, "use-snake-case", "medium");
    writeRule(globalRoot, "avoid-i-prefix", "low");

    // Repo WITH .betterai: overrides use-snake-case, adds a repo-only rule.
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    writeFileSync(join(repoRoot, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src/x.ts"), "// x\n");
    writeRule(join(repoRoot, ".betterai"), "use-snake-case", "high");
    writeRule(join(repoRoot, ".betterai"), "repo-naming-prefix", "high");

    // Repo WITHOUT .betterai: a git root but no readable repo corpus.
    mkdirSync(join(bareRepoRoot, ".git"), { recursive: true });
    writeFileSync(join(bareRepoRoot, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(bareRepoRoot, "src"), { recursive: true });
    writeFileSync(join(bareRepoRoot, "src/y.ts"), "// y\n");

    // Loose files: one matching the rule glob, one matching nothing.
    writeFileSync(join(looseDir, "file.ts"), "// loose\n");
    writeFileSync(join(looseDir, "notes.txt"), "loose notes\n");
  });

  afterAll(() => {
    for (const dir of [globalRoot, emptyGlobalRoot, repoRoot, bareRepoRoot, looseDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let callSeq = 0;
  function meta(): ToolCallMeta {
    callSeq += 1;
    return {
      agent_session_id: "test-session-1",
      parent_agent_session_id: null,
      subagent_class: "main",
      tool_call_id: `test-call-${callSeq}`,
    };
  }

  /**
   * Build a fake ToolContext around a REAL orchestrator over the fixture
   * corpora — the same construction pattern as src/server/main.ts
   * (DomainRouter, ContextCache, RepoDetector, fake audit writer). The
   * tool only touches ctx.orchestrator, so the remaining ToolContext
   * surface is intentionally absent.
   */
  function makeCtx(corpusRoot: string = globalRoot): {
    ctx: ToolContext;
    events: AuditEvent[];
  } {
    const events: AuditEvent[] = [];
    const orchestrator = new RetrievalOrchestrator({
      globalCorpusRoot: corpusRoot,
      router: new DomainRouter({
        routers: [],
        defaults: {
          domains: ["naming"],
          max_rules_per_domain: 4,
          max_total_rules: 12,
        },
      }),
      cache: new ContextCache(),
      repoDetector: new RepoDetector({ stopAt: ["/", tmpdir()] }),
      auditLog: (e: AuditEvent) => events.push(e),
    });
    return { ctx: { orchestrator } as unknown as ToolContext, events };
  }

  async function call(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<RetrieveContextOut> {
    return (await retrieveContext.handler(
      input,
      ctx,
      meta(),
    )) as unknown as RetrieveContextOut;
  }

  const repoInput = () => ({
    context: {
      file_paths: [join(repoRoot, "src/x.ts")],
      intent: "rename a variable",
    },
    scope: "merged",
    top_k_per_kind: 8,
  });

  test("merges global and repo rules into a single response shape", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, repoInput());
    expect(Array.isArray(out.rules)).toBe(true);
    expect(Array.isArray(out.overridden_global_ids)).toBe(true);
    expect(out.repo_root_detected).toBe(repoRoot);
  });

  test("REGRESSION: a repo-only rule IS returned when the repo corpus exists", async () => {
    // The pre-fix tool could never return this rule: the singleton reader
    // had no repoRoot, so repo artifacts were silently invisible.
    const { ctx } = makeCtx();
    const out = await call(ctx, repoInput());

    const repoOnly = out.rules.find((r) => r.id === "repo-naming-prefix");
    expect(repoOnly).toBeDefined();
    expect(repoOnly?.scope).toBe("repo");
    expect(out.scopes_queried).toEqual(["global", "repo"]);
  });

  test("drops the global version of a rule when the repo declares the same id", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, repoInput());

    const colliding = out.rules.filter((r) => r.id === "use-snake-case");
    expect(colliding.length).toBe(1);
    expect(colliding[0].scope).toBe("repo");
    expect(colliding[0].severity).toBe("high"); // the repo version survived
    expect(out.overridden_global_ids).toContain("use-snake-case");
  });

  test("includes the global-only rule when the repo does not declare its id", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, repoInput());

    const additive = out.rules.find((r) => r.id === "avoid-i-prefix");
    expect(additive).toBeDefined();
    expect(additive?.scope).toBe("global");
  });

  test("returns only global rules when the context has no detectable repo root", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, {
      context: {
        file_paths: [join(looseDir, "file.ts")],
        intent: "rename a variable",
      },
      scope: "merged",
    });

    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((r) => r.scope === "global")).toBe(true);
    expect(out.overridden_global_ids).toEqual([]);
    expect(out.scopes_queried).toEqual(["global"]);
    expect(out.repo_root_detected).toBeNull();
  });

  test("scopes_queried includes 'repo' ONLY when the repo corpus is actually readable", async () => {
    // A git repo WITHOUT .betterai/: the repo root is detected, but the
    // repo corpus is not readable — reporting "repo" here would be the
    // exact observability lie this delegation fixes.
    const { ctx, events } = makeCtx();
    const out = await call(ctx, {
      context: {
        file_paths: [join(bareRepoRoot, "src/y.ts")],
        intent: "rename a variable",
      },
      scope: "merged",
    });

    expect(out.repo_root_detected).toBe(bareRepoRoot);
    expect(out.scopes_queried).toEqual(["global"]);
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((r) => r.scope === "global")).toBe(true);
    // The audit event reports the same reality.
    expect(events).toHaveLength(1);
    expect(events[0].scopes_queried).toEqual(["global"]);
  });

  test("exactly one audit event per call; cache_hit true on repeat with identical payload", async () => {
    const { ctx, events } = makeCtx();

    const first = await call(ctx, repoInput());
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("retrieve");
    expect(events[0].cache_hit).toBe(false);

    const second = await call(ctx, repoInput());
    expect(events).toHaveLength(2);
    expect(events[1].event_type).toBe("retrieve");
    expect(events[1].cache_hit).toBe(true);
    expect(second).toEqual(first);
  });

  // ---- G5-M1: structured no-match (docs/RELIABILITY-TEST-GAPS.md) ----------
  //
  // "Search returns nothing" is the fault-tolerance mode most likely to
  // fire in dogfooding. The contract: zero artifacts across every kind
  // returns { match: "none", reason: "no_match", query_echo, ... } —
  // a first-class shape agents can branch on — never bare empty arrays.

  test("empty corpus returns the structured no-match shape, not bare empty arrays", async () => {
    const { ctx } = makeCtx(emptyGlobalRoot);

    const out = await call(ctx, {
      context: {
        file_paths: [join(looseDir, "file.ts")],
        intent: "rename a variable",
      },
      scope: "merged",
    });

    expect(out.match).toBe("none");
    expect(out.reason).toBe("no_match");
    expect(out.query_echo).toEqual({
      intent: "rename a variable",
      file_paths: [join(looseDir, "file.ts")],
      symbols: [],
    });
    expect(out.scopes_queried).toEqual(["global"]);
    // The v1.0 arrays are still present (additive extension), just empty.
    expect(out.rules).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.memories).toEqual([]);
  });

  test("non-empty corpus with a non-matching query also returns the no-match shape", async () => {
    // The corpus has rules, but neither the path glob (**/*.ts) nor the
    // intent keyword ("rename") matches this query.
    const { ctx } = makeCtx();

    const out = await call(ctx, {
      context: {
        file_paths: [join(looseDir, "notes.txt")],
        intent: "deploy a kubernetes operator",
      },
      scope: "merged",
    });

    expect(out.match).toBe("none");
    expect(out.reason).toBe("no_match");
    expect(out.query_echo?.intent).toBe("deploy a kubernetes operator");
    expect(out.rules).toEqual([]);
  });

  test("no-match retrieval still emits exactly one audit event with rules_returned: []", async () => {
    const { ctx, events } = makeCtx(emptyGlobalRoot);

    await call(ctx, {
      context: {
        file_paths: [join(looseDir, "notes.txt")],
        intent: "anything at all",
      },
      scope: "merged",
    });

    // The no-match path stays observable in the audit trail.
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("retrieve");
    expect(events[0].rules_returned).toEqual([]);
  });

  test("matching query is unchanged except for the additive match: 'matched' discriminant", async () => {
    const { ctx } = makeCtx();

    const out = await call(ctx, repoInput());

    expect(out.match).toBe("matched");
    expect(out.reason).toBeUndefined();
    expect(out.query_echo).toBeUndefined();
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.overridden_global_ids).toContain("use-snake-case");
  });
});
