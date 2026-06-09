// 35-case schema validator suite per multi-agent eng review §3.2.A and
// corpus eng review §3.2: 18 rule + 6 skill + 6 memory + 5 audit.
// All tests use in-memory string corpora; the only filesystem touchpoint is
// validateCorpus(), which gets a tmpdir scratch tree.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRule,
  validateSkill,
  validateMemory,
  validateAuditEvent,
  validateCorpus,
} from "./rule-schema.js";

// -------------------- Rule fixtures --------------------

const WELL_FORMED_RULE = `---
id: webhook-handlers-must-dedupe
title: Webhook handlers must deduplicate on event id
category: STANDARDS
domain: idempotency
severity: high
created: 2026-06-09
applies_when:
  paths: ["**/webhooks/**/*.ts"]
related: [error-boundaries-at-the-edge]
---

## What this rule says
Body content here.

## Why it matters
The cost.

## When this applies
Trigger conditions.

## What good looks like
Compliant code.

## Anti-patterns
Wrong, then fixed.

## Examples
\`\`\`ts
const x = 1;
\`\`\`
`;

function ruleMissing(field: string): string {
  return WELL_FORMED_RULE.split("\n")
    .filter(l => !l.startsWith(`${field}:`))
    .join("\n");
}

// -------------------- Rule tests (18) --------------------

describe("validateRule", () => {
  test("accepts a well-formed rule with all required fields and body sections", () => {
    const r = validateRule("test.md", WELL_FORMED_RULE);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("rejects a rule missing the YAML frontmatter block entirely", () => {
    const r = validateRule("test.md", "# just a title\nno frontmatter here");
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === "NO_FRONTMATTER")).toBe(true);
  });

  test("rejects a rule missing the required id field", () => {
    const r = validateRule("test.md", ruleMissing("id"));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === "frontmatter.id")).toBe(true);
  });

  test("rejects a rule with an id that is not kebab-case", () => {
    const bad = WELL_FORMED_RULE.replace("id: webhook-handlers-must-dedupe", "id: WebhookHandler");
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "ID_NOT_KEBAB_CASE")).toBe(true);
  });

  test("rejects a rule missing the required title field", () => {
    const r = validateRule("test.md", ruleMissing("title"));
    expect(r.errors.some(e => e.field === "frontmatter.title")).toBe(true);
  });

  test("warns when the title exceeds 80 characters", () => {
    const long = "x".repeat(81);
    const bad = WELL_FORMED_RULE.replace(
      "title: Webhook handlers must deduplicate on event id",
      `title: ${long}`,
    );
    const r = validateRule("test.md", bad);
    expect(r.warnings.some(w => w.code === "TITLE_TOO_LONG")).toBe(true);
  });

  test("rejects a category outside the fixed enum of five values", () => {
    const bad = WELL_FORMED_RULE.replace("category: STANDARDS", "category: standards");
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "CATEGORY_NOT_IN_ENUM")).toBe(true);
  });

  test("rejects a rule missing the required domain field", () => {
    const r = validateRule("test.md", ruleMissing("domain"));
    expect(r.errors.some(e => e.field === "frontmatter.domain")).toBe(true);
  });

  test("rejects severity outside low|medium|high", () => {
    const bad = WELL_FORMED_RULE.replace("severity: high", "severity: critical");
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "SEVERITY_NOT_IN_ENUM")).toBe(true);
  });

  test("rejects a rule whose created field is not an ISO date", () => {
    const bad = WELL_FORMED_RULE.replace("created: 2026-06-09", "created: yesterday");
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "DATE_NOT_ISO")).toBe(true);
  });

  test("rejects check.kind=shell as a v1-forbidden execution sink", () => {
    const bad = WELL_FORMED_RULE.replace(
      "applies_when:",
      "check:\n  kind: shell\n  pattern: ls\napplies_when:",
    );
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "CHECK_KIND_FORBIDDEN")).toBe(true);
  });

  test("rejects check.kind=ts-module as a v1-forbidden execution sink", () => {
    const bad = WELL_FORMED_RULE.replace(
      "applies_when:",
      "check:\n  kind: ts-module\n  pattern: ./check.ts\napplies_when:",
    );
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "CHECK_KIND_FORBIDDEN")).toBe(true);
  });

  test("accepts check.kind=regex as a v1-allowed pattern", () => {
    const ok = WELL_FORMED_RULE.replace(
      "applies_when:",
      "check:\n  kind: regex\n  pattern: foo\napplies_when:",
    );
    const r = validateRule("test.md", ok);
    expect(r.errors.filter(e => e.code === "CHECK_KIND_FORBIDDEN")).toEqual([]);
  });

  test("rejects check.kind set to an unknown value", () => {
    const bad = WELL_FORMED_RULE.replace(
      "applies_when:",
      "check:\n  kind: lsp\n  pattern: foo\napplies_when:",
    );
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "CHECK_KIND_UNKNOWN")).toBe(true);
  });

  test("rejects a body missing one of the six required H2 sections", () => {
    const bad = WELL_FORMED_RULE.replace("## Anti-patterns\nWrong, then fixed.\n", "");
    const r = validateRule("test.md", bad);
    expect(r.errors.some(e => e.code === "BODY_MISSING_SECTION")).toBe(true);
  });

  test("rejects a body whose sections appear in the wrong order", () => {
    const swapped = WELL_FORMED_RULE.replace(
      /## What this rule says\nBody content here\.\n\n## Why it matters\nThe cost\./,
      "## Why it matters\nThe cost.\n\n## What this rule says\nBody content here.",
    );
    const r = validateRule("test.md", swapped);
    expect(r.errors.some(e => e.code === "BODY_MISSING_SECTION")).toBe(true);
  });

  test("warns on a title that ends with a trailing period per house style", () => {
    const bad = WELL_FORMED_RULE.replace(
      "title: Webhook handlers must deduplicate on event id",
      "title: Webhook handlers must deduplicate on event id.",
    );
    const r = validateRule("test.md", bad);
    expect(r.warnings.some(w => w.code === "TITLE_TRAILING_PERIOD")).toBe(true);
  });

  test("preserves parsed frontmatter on the result for downstream consumers", () => {
    const r = validateRule("test.md", WELL_FORMED_RULE);
    expect(r.parsed?.fields.id).toBe("webhook-handlers-must-dedupe");
    expect(r.parsed?.fields.severity).toBe("high");
  });
});

// -------------------- Skill fixtures --------------------

const WELL_FORMED_SKILL = `---
id: add-mcp-tool
title: Add a new MCP tool to betterai-server
category: mcp-development
when_to_use: |
  When adding an MCP tool. Multi-line OK.
steps_count: 7
created: 2026-06-09
---

## When to use this skill
Trigger.

## Prerequisites
Setup.

## Steps
1. Step one.

## What good looks like
End state.

## Common failure modes
What goes wrong.

## Related rules
- linked-rule
`;

// -------------------- Skill tests (6) --------------------

describe("validateSkill", () => {
  test("accepts a well-formed skill with required frontmatter and six body sections", () => {
    const r = validateSkill("test.md", WELL_FORMED_SKILL);
    expect(r.ok).toBe(true);
  });

  test("rejects a skill missing the when_to_use field", () => {
    const bad = WELL_FORMED_SKILL.split("when_to_use: |\n  When adding an MCP tool. Multi-line OK.\n").join("");
    const r = validateSkill("test.md", bad);
    expect(r.errors.some(e => e.field === "frontmatter.when_to_use")).toBe(true);
  });

  test("rejects a skill that mistakenly carries a severity field", () => {
    const bad = WELL_FORMED_SKILL.replace("steps_count: 7", "steps_count: 7\nseverity: high");
    const r = validateSkill("test.md", bad);
    expect(r.errors.some(e => e.code === "SKILL_HAS_SEVERITY")).toBe(true);
  });

  test("rejects a skill whose steps_count is zero or negative", () => {
    const bad = WELL_FORMED_SKILL.replace("steps_count: 7", "steps_count: 0");
    const r = validateSkill("test.md", bad);
    expect(r.errors.some(e => e.code === "STEPS_COUNT_INVALID")).toBe(true);
  });

  test("rejects a skill body missing the Steps H2 section", () => {
    const bad = WELL_FORMED_SKILL.replace("## Steps\n1. Step one.\n\n", "");
    const r = validateSkill("test.md", bad);
    expect(r.errors.some(e => e.code === "BODY_MISSING_SECTION")).toBe(true);
  });

  test("accepts a skill with the optional codified_from field present", () => {
    const ok = WELL_FORMED_SKILL.replace(
      "steps_count: 7",
      "steps_count: 7\ncodified_from: prior-flow",
    );
    const r = validateSkill("test.md", ok);
    expect(r.ok).toBe(true);
  });
});

// -------------------- Memory fixtures --------------------

const WELL_FORMED_MEMORY = `---
id: docker-mcp-stdio-vs-http
title: Picked HTTP over stdio for MCP transport
date: 2026-06-09
project: betterai
kind: decision
context_keywords: [mcp, docker, transport]
durability: long
auto_captured: false
---

## What happened
We picked HTTP/SSE.

## Why it matters (for future me)
Stdio doesn't propagate to subagents.

## Don't relitigate
Do not add a stdio path.
`;

// -------------------- Memory tests (6) --------------------

describe("validateMemory", () => {
  test("accepts a well-formed memory living in the correct yyyy-mm shard", () => {
    const r = validateMemory("/tmp/memories/2026-06/docker.md", WELL_FORMED_MEMORY);
    expect(r.ok).toBe(true);
  });

  test("rejects a memory missing the kind field", () => {
    const bad = WELL_FORMED_MEMORY.split("\n").filter(l => !l.startsWith("kind:")).join("\n");
    const r = validateMemory("/tmp/memories/2026-06/x.md", bad);
    expect(r.errors.some(e => e.field === "frontmatter.kind")).toBe(true);
  });

  test("rejects a memory whose kind is outside the fixed enum", () => {
    const bad = WELL_FORMED_MEMORY.replace("kind: decision", "kind: hunch");
    const r = validateMemory("/tmp/memories/2026-06/x.md", bad);
    expect(r.errors.some(e => e.code === "KIND_NOT_IN_ENUM")).toBe(true);
  });

  test("rejects a memory with an empty context_keywords array", () => {
    const bad = WELL_FORMED_MEMORY.replace("context_keywords: [mcp, docker, transport]", "context_keywords: []");
    const r = validateMemory("/tmp/memories/2026-06/x.md", bad);
    expect(r.errors.some(e => e.code === "CONTEXT_KEYWORDS_MISSING")).toBe(true);
  });

  test("warns when a memory lives outside the yyyy-mm shard matching its date", () => {
    const r = validateMemory("/tmp/memories/2026-05/wrong-shard.md", WELL_FORMED_MEMORY);
    expect(r.warnings.some(w => w.code === "MEMORY_SHARD_MISMATCH")).toBe(true);
  });

  test("warns when a short-durability memory has an expires_on date in the past", () => {
    const expired = WELL_FORMED_MEMORY.replace(
      "durability: long",
      "durability: short\nexpires_on: 2020-01-01",
    );
    const r = validateMemory("/tmp/memories/2026-06/x.md", expired);
    expect(r.warnings.some(w => w.code === "MEMORY_EXPIRED")).toBe(true);
  });
});

// -------------------- Audit tests (5) --------------------

function baseAudit() {
  return {
    event_type: "retrieve",
    ts: "2026-06-09T14:13:23.456Z",
    agent_session_id: "claude-code:abc",
    parent_agent_session_id: null,
    subagent_class: "main",
    tool_call_id: "tool_xyz",
    context_hash: "sha256:dead",
    repo_root_detected: null,
    scopes_queried: ["global"],
    rules_returned: [],
    overridden_global_ids: [],
    latency_ms: 42,
    downstream_apply_event_id: null,
    downstream_commit_sha: null,
    downstream_violations: null,
  };
}

describe("validateAuditEvent", () => {
  test("accepts a main-loop retrieve event with null parent_agent_session_id", () => {
    const r = validateAuditEvent(baseAudit());
    expect(r.ok).toBe(true);
  });

  test("rejects a subagent event missing parent_agent_session_id per .betterai observability rule", () => {
    const e = { ...baseAudit(), subagent_class: "agent-tool", parent_agent_session_id: null };
    const r = validateAuditEvent(e);
    expect(r.ok).toBe(false);
    expect(r.errors.some(x => x.code === "AUDIT_MISSING_PARENT")).toBe(true);
  });

  test("rejects an event_type outside the locked enum", () => {
    const e = { ...baseAudit(), event_type: "telemetry" };
    const r = validateAuditEvent(e);
    expect(r.errors.some(x => x.code === "AUDIT_BAD_EVENT_TYPE")).toBe(true);
  });

  test("rejects a subagent_class not in main|agent-tool|workflow|background|cron", () => {
    const e = { ...baseAudit(), subagent_class: "sidecar" };
    const r = validateAuditEvent(e);
    expect(r.errors.some(x => x.code === "AUDIT_BAD_SUBAGENT_CLASS")).toBe(true);
  });

  test("rejects scopes_queried entries that are not global or repo", () => {
    const e = { ...baseAudit(), scopes_queried: ["global", "personal"] };
    const r = validateAuditEvent(e);
    expect(r.errors.some(x => x.code === "AUDIT_BAD_SCOPE_VALUE")).toBe(true);
  });
});

// -------------------- Corpus walker integration --------------------

describe("validateCorpus", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "betterai-corpus-"));
    mkdirSync(join(root, "rules/STANDARDS/idempotency"), { recursive: true });
    mkdirSync(join(root, "skills/mcp-development"), { recursive: true });
    mkdirSync(join(root, "memories/2026-06"), { recursive: true });
    writeFileSync(join(root, "rules/STANDARDS/idempotency/r1.md"), WELL_FORMED_RULE);
    writeFileSync(join(root, "skills/mcp-development/s1.md"), WELL_FORMED_SKILL);
    writeFileSync(join(root, "memories/2026-06/m1.md"), WELL_FORMED_MEMORY);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("walks a populated corpus and aggregates per-file results", () => {
    const report = validateCorpus(root);
    expect(report.filesScanned).toBe(3);
    expect(report.rulesValidated).toBe(1);
    expect(report.skillsValidated).toBe(1);
    expect(report.memoriesValidated).toBe(1);
  });

  test("detects duplicate rule ids within the same scope as an error", () => {
    const dupDir = mkdtempSync(join(tmpdir(), "betterai-dup-"));
    mkdirSync(join(dupDir, "rules/STANDARDS/idempotency"), { recursive: true });
    writeFileSync(join(dupDir, "rules/STANDARDS/idempotency/r1.md"), WELL_FORMED_RULE);
    writeFileSync(join(dupDir, "rules/STANDARDS/idempotency/r2.md"), WELL_FORMED_RULE);
    const report = validateCorpus(dupDir);
    expect(report.duplicateIdsWithinScope.length).toBe(1);
    rmSync(dupDir, { recursive: true, force: true });
  });
});
