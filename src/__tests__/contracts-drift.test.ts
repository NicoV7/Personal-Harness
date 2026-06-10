// src/__tests__/contracts-drift.test.ts
//
// Drift detection for the shared contracts module (src/contracts/).
//
// Two layers:
//   1. STATIC — bidirectional assignability assertions between the
//      contract types and the live server types. The same guards live
//      inside the contract modules themselves (e.g. AuditContractDriftChecks)
//      so `npm run typecheck` fails on divergence even though tsconfig
//      excludes test files; the const-style checks below repeat them in
//      the canonical `const _x: A = {} as B` form so any future
//      vitest --typecheck / test-inclusive tsconfig also catches drift.
//   2. RUNTIME — Zod .parse() smoke tests on representative fixtures
//      (a valid retrieve audit event, a valid env object) so schema
//      regressions fail `npm test` too.

import { describe, expect, test } from "vitest";

import {
  AuditEventSchema,
  EnvSchema,
  SCHEMA_VERSION,
  allowedHostsFromEnv,
  DEFAULT_MCP_PORT,
  DEFAULT_BIND_HOST,
  DEFAULT_RETRIEVAL_MODE,
  type AuditEvent as ContractAuditEvent,
  type AuditEventRuleEntry as ContractAuditEventRuleEntry,
  type MatchContext as ContractMatchContext,
  type McpTool as ContractMcpTool,
  type OrchestratorMeta as ContractOrchestratorMeta,
  type ResolvedEnv as ContractResolvedEnv,
  type RetrievalScorer,
  type RetrieveInput as ContractRetrieveInput,
  type RetrieveOutput as ContractRetrieveOutput,
  type Rule,
  type ScopeFilter as ContractScopeFilter,
  type ScoredArtifact as ContractScoredArtifact,
  type ToolCallMeta as ContractToolCallMeta,
} from "../contracts/index.js";

import type {
  AuditEvent as LiveAuditEvent,
  AuditEventRuleEntry as LiveAuditEventRuleEntry,
} from "../server/audit/jsonl.js";
import type {
  MatchContext as LiveMatchContext,
  ScoredArtifact as LiveScoredArtifact,
} from "../server/retrieve/grep.js";
import type {
  OrchestratorMeta as LiveOrchestratorMeta,
  RetrieveInput as LiveRetrieveInput,
  RetrieveOutput as LiveRetrieveOutput,
  ScopeFilter as LiveScopeFilter,
} from "../server/retrieve/index.js";
import type {
  McpTool as LiveMcpTool,
  ResolvedEnv as LiveResolvedEnv,
  ToolCallMeta as LiveToolCallMeta,
} from "../server/main.js";

// ---- 1. Static drift assertions (erased at runtime) -----------------------
//
// Each pair asserts BIDIRECTIONAL assignability: contract ⇐ live and
// live ⇐ contract. Any structural divergence turns one of these lines
// into a type error.

function staticDriftAssertions(): void {
  // audit
  const a1: ContractAuditEvent = {} as LiveAuditEvent;
  const a2: LiveAuditEvent = {} as ContractAuditEvent;
  const a3: ContractAuditEventRuleEntry = {} as LiveAuditEventRuleEntry;
  const a4: LiveAuditEventRuleEntry = {} as ContractAuditEventRuleEntry;

  // retrieval
  const r1: ContractMatchContext = {} as LiveMatchContext;
  const r2: LiveMatchContext = {} as ContractMatchContext;
  const r3: ContractScoredArtifact<Rule> = {} as LiveScoredArtifact<Rule>;
  const r4: LiveScoredArtifact<Rule> = {} as ContractScoredArtifact<Rule>;
  const r5: ContractRetrieveInput = {} as LiveRetrieveInput;
  const r6: LiveRetrieveInput = {} as ContractRetrieveInput;
  const r7: ContractRetrieveOutput = {} as LiveRetrieveOutput;
  const r8: LiveRetrieveOutput = {} as ContractRetrieveOutput;
  const r9: ContractScopeFilter = {} as LiveScopeFilter;
  const r10: LiveScopeFilter = {} as ContractScopeFilter;

  // tool
  const t1: ContractToolCallMeta = {} as LiveToolCallMeta;
  const t2: LiveToolCallMeta = {} as ContractToolCallMeta;
  const t3: ContractOrchestratorMeta = {} as LiveOrchestratorMeta;
  const t4: LiveOrchestratorMeta = {} as ContractOrchestratorMeta;
  const t5: ContractMcpTool = {} as LiveMcpTool;
  const t6: LiveMcpTool = {} as ContractMcpTool;

  // env — the contract is a strict superset of the live schema: every
  // live key must exist on the contract with an identical type.
  const e1: LiveResolvedEnv = {} as ContractResolvedEnv;
  const e2: Pick<ContractResolvedEnv, keyof LiveResolvedEnv> =
    {} as LiveResolvedEnv;

  void [a1, a2, a3, a4, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10];
  void [t1, t2, t3, t4, t5, t6, e1, e2];
}
void staticDriftAssertions;

// The RetrievalScorer seam: a minimal deterministic grep-style stub must
// satisfy the interface (compile-time check that the seam is implementable).
const stubScorer: RetrievalScorer = {
  mode: "grep",
  scoreRules: async (rules, _ctx) =>
    rules.map((item) => ({ item, score: 0, reason: "no-match" })),
  scoreSkills: async (skills, _ctx) =>
    skills.map((item) => ({ item, score: 0, reason: "no-match" })),
  scoreMemories: async (memories, _ctx) =>
    memories.map((item) => ({ item, score: 0, reason: "no-match" })),
};

// ---- 2. Runtime Zod smoke tests --------------------------------------------

function validRetrieveEvent(): ContractAuditEvent {
  return {
    event_type: "retrieve",
    ts: "2026-06-10T08:00:00.000Z",
    agent_session_id: "claude-code:session-xyz",
    parent_agent_session_id: null,
    subagent_class: "main",
    tool_call_id: "tc_contract_smoke",
    context_hash: "sha256:abc123",
    repo_root_detected: "/projects/betterai",
    scopes_queried: ["global", "repo"],
    rules_returned: [
      {
        id: "no-stdio-mcp-transport",
        kind: "rule",
        scope: "repo",
        domain: "maintainability",
        score: 9,
        reason: "path-match,intent-match",
      },
    ],
    overridden_global_ids: ["simplicity-first"],
    latency_ms: 12,
    cache_hit: true,
    downstream_apply_event_id: null,
    downstream_commit_sha: null,
    downstream_violations: null,
  };
}

describe("contracts: AuditEventSchema", () => {
  test("parses a representative retrieve event (round-trips unchanged)", () => {
    const event = validRetrieveEvent();
    const parsed = AuditEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  test("cache_hit is optional — an event without it still parses", () => {
    const { cache_hit: _omitted, ...rest } = validRetrieveEvent();
    expect(AuditEventSchema.parse(rest).cache_hit).toBeUndefined();
  });

  test("rejects an unknown event_type", () => {
    const bad = { ...validRetrieveEvent(), event_type: "telemetry" };
    expect(() => AuditEventSchema.parse(bad)).toThrow();
  });

  test("rejects non-null v2 reserved downstream fields", () => {
    const bad = {
      ...validRetrieveEvent(),
      downstream_commit_sha: "deadbeef",
    };
    expect(() => AuditEventSchema.parse(bad)).toThrow();
  });

  test("rejects a malformed rules_returned entry", () => {
    const bad = {
      ...validRetrieveEvent(),
      rules_returned: [{ id: "x", kind: "rule", scope: "everywhere" }],
    };
    expect(() => AuditEventSchema.parse(bad)).toThrow();
  });
});

describe("contracts: EnvSchema", () => {
  test("an empty env resolves to the documented defaults", () => {
    const env = EnvSchema.parse({});
    expect(env.BETTERAI_BIND_HOST).toBe(DEFAULT_BIND_HOST);
    expect(env.BETTERAI_MCP_PORT).toBe(DEFAULT_MCP_PORT);
    expect(env.BETTERAI_CORPUS_ROOT).toBe("/data");
    expect(env.BETTERAI_AUDIT_PATH).toBe("/data/audit/audit.jsonl");
    expect(env.BETTERAI_TOKEN_PATH).toBe("/data/token");
    expect(env.BETTERAI_RETRIEVAL_MODE).toBe(DEFAULT_RETRIEVAL_MODE);
    expect(env.BETTERAI_RETRIEVAL_MODE).toBe("hybrid");
    expect(env.BETTERAI_MODEL_CACHE_DIR).toBe("/data/embeddings/models");
    expect(env.BETTERAI_ALLOWED_HOSTS).toBeUndefined();
  });

  test("parses a fully-populated v1.5 env object", () => {
    const env = EnvSchema.parse({
      BETTERAI_CORPUS_ROOT: "/data",
      BETTERAI_AUDIT_PATH: "/data/audit/audit.jsonl",
      BETTERAI_PROJECTS_ROOT: "/projects",
      BETTERAI_MCP_PORT: "7777", // env vars are strings; schema coerces
      BETTERAI_TOKEN_PATH: "/data/token",
      BETTERAI_LOG_LEVEL: "debug",
      BETTERAI_BIND_HOST: "127.0.0.1",
      BETTERAI_ALLOWED_HOSTS: "127.0.0.1:7777, localhost:7777",
      BETTERAI_RETRIEVAL_MODE: "embedding",
      BETTERAI_MODEL_CACHE_DIR: "/data/embeddings/models",
    });
    expect(env.BETTERAI_MCP_PORT).toBe(7777);
    expect(env.BETTERAI_RETRIEVAL_MODE).toBe("embedding");
  });

  test("rejects an unknown retrieval mode", () => {
    expect(() =>
      EnvSchema.parse({ BETTERAI_RETRIEVAL_MODE: "vibes" }),
    ).toThrow();
  });

  test("allowedHostsFromEnv: explicit allowlist wins, else derived", () => {
    const base = EnvSchema.parse({});
    expect(allowedHostsFromEnv(base)).toEqual(
      new Set(["127.0.0.1:7777", "localhost:7777"]),
    );
    const overridden = EnvSchema.parse({
      BETTERAI_ALLOWED_HOSTS: "betterai.internal:9999, 10.0.0.5:7777",
    });
    expect(allowedHostsFromEnv(overridden)).toEqual(
      new Set(["betterai.internal:9999", "10.0.0.5:7777"]),
    );
  });

  test("schema_version constant is locked at 1.5", () => {
    expect(SCHEMA_VERSION).toBe("1.5");
  });
});

describe("contracts: RetrievalScorer seam", () => {
  test("a deterministic stub satisfies the interface and is mode-tagged", async () => {
    expect(stubScorer.mode).toBe("grep");
    const ctx: ContractMatchContext = {
      file_paths: ["src/server/main.ts"],
      intent: "add an endpoint",
      symbols: ["startServer"],
      recent_diff: "",
    };
    // Determinism contract: same corpus + ctx → identical results.
    const first = await stubScorer.scoreRules([], ctx);
    const second = await stubScorer.scoreRules([], ctx);
    expect(first).toEqual(second);
  });
});
