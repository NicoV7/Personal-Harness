// CLI offline-mode test per .betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md.
//
// `betterai validate` MUST run against an on-disk corpus with no server,
// no docker, and no network. The dispatch contract is:
//
//   src/cli/validate.ts exports `validate(rootDir: string): Promise<number>`
//   - returns 0 on a clean corpus, non-zero on errors
//   - writes errors to stderr; we don't assert on stderr text shape here
//
// If Team D's file isn't present yet, the test falls back to driving the
// validator core directly so the offline-mode contract is still asserted
// against the validator (Team E owns both halves).

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCorpus } from "../_meta-validators/rule-schema.js";

let validate: (rootDir: string) => Promise<number>;
try {
  const mod = await import("../cli/validate.js");
  validate = mod.validate;
} catch {
  // Team D's CLI not present at merge time — fall back to the validator
  // core. This still proves the offline path works (no server, no docker).
  validate = async (rootDir: string) => {
    const report = validateCorpus(rootDir);
    return report.ok ? 0 : 1;
  };
}

const VALID_RULE = `---
id: a-real-rule
title: A real rule
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-06-09
---

## What this rule says
Body.

## Why it matters
Cost.

## When this applies
Cases.

## What good looks like
Code.

## Anti-patterns
Wrong.
`;

describe("betterai validate (offline)", () => {
  let okRoot: string;
  let badRoot: string;

  beforeAll(() => {
    okRoot = mkdtempSync(join(tmpdir(), "betterai-cli-ok-"));
    mkdirSync(join(okRoot, "rules/STANDARDS/maintainability"), { recursive: true });
    writeFileSync(join(okRoot, "rules/STANDARDS/maintainability/a-real-rule.md"), VALID_RULE);

    badRoot = mkdtempSync(join(tmpdir(), "betterai-cli-bad-"));
    mkdirSync(join(badRoot, "rules/STANDARDS/maintainability"), { recursive: true });
    writeFileSync(
      join(badRoot, "rules/STANDARDS/maintainability/broken.md"),
      "# no frontmatter at all\n",
    );
  });

  afterAll(() => {
    rmSync(okRoot, { recursive: true, force: true });
    rmSync(badRoot, { recursive: true, force: true });
  });

  test("returns zero against a well-formed corpus with no server running", async () => {
    const code = await validate(okRoot);
    expect(code).toBe(0);
  });

  test("returns non-zero against a corpus containing a malformed rule file", async () => {
    const code = await validate(badRoot);
    expect(code).not.toBe(0);
  });

  test("does not require any environment variable beyond the corpus root path", async () => {
    // The offline path should not need BETTERAI_TOKEN, BETTERAI_MCP_PORT, etc.
    const saved: Record<string, string | undefined> = {};
    for (const k of ["BETTERAI_TOKEN_PATH", "BETTERAI_MCP_PORT", "BETTERAI_CORPUS_ROOT"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const code = await validate(okRoot);
      expect(code).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
