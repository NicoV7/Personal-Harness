// Unit tests for the hand-rolled domain-router YAML parser + DomainRouter.fromFile.
//
// REGRESSION GUARD: parseYaml was dead before 29b7771 — it parsed the top level
// with parentIndent=0, so the firstIndent detector grabbed the grandchild indent
// and every top-level key (routers:, defaults:) was dropped, yielding an empty
// config so EVERY request fell back to default domains. The fix parses the top
// level with parentIndent=-1. These tests pin the live shipped domain-router.yaml
// AND the nested empty-node edge case that used to store a malformed [{},0] tuple.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainRouter } from "../retrieval/router.js";

const REPO_ROUTER = join(process.cwd(), "rules/_meta/domain-router.yaml");

describe("DomainRouter.fromFile on the shipped domain-router.yaml", () => {
  const router = DomainRouter.fromFile(REPO_ROUTER);

  test("a .ts path routes to code-health domains (parser is NOT dead)", () => {
    const r = router.route({ file_paths: ["src/app.ts"], intent: "implement" });
    // If parseYaml regressed to parentIndent=0 the config would be empty and
    // this would be exactly the defaults [maintainability, methodology] with
    // fired:[]. Assert a router actually fired and a non-default domain is present.
    expect(r.domains).toContain("error-handling");
    expect(r.domains).toContain("structure");
  });

  test("an auth/ path adds the security domain", () => {
    const r = router.route({
      file_paths: ["src/auth/bearer.ts"],
      intent: "edit",
    });
    expect(r.domains).toContain("security");
  });

  test("a website/frontend intent surfaces frontend + accessibility", () => {
    const r = router.route({
      file_paths: ["site/index.html"],
      intent: "design and build a personal portfolio website",
    });
    expect(r.domains).toContain("frontend");
    expect(r.domains).toContain("accessibility");
  });

  test("an unmatched/vague request falls back to defaults only", () => {
    const r = router.route({ file_paths: [], intent: "" });
    expect(r.domains.sort()).toEqual(["maintainability", "methodology"]);
    expect(r.max_rules_per_domain).toBe(4);
    expect(r.max_total_rules).toBe(12);
  });
});

describe("parser edge cases (via fromFile on temp YAML)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "router-yaml-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function routerFrom(yaml: string): DomainRouter {
    const p = join(dir, `r-${Math.abs(hash(yaml))}.yaml`);
    writeFileSync(p, yaml);
    return DomainRouter.fromFile(p);
  }
  function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  test("nested empty-value key followed by a dedent does NOT corrupt parsing", () => {
    // Pre-fix, the `[emptyOrFirst()] as never` branch stored the raw [{},0]
    // tuple as the value of `domains`, producing a garbage config. A well-formed
    // empty node must let the router load and route without throwing.
    const yaml = [
      "routers:",
      "  - id: edge",
      "    rules:",
      "      - if_intent_contains: [build]",
      "        domains: [maintainability]",
      "defaults:",
      "  domains: [maintainability, methodology]",
      "  max_rules_per_domain: 4",
      "  max_total_rules: 12",
    ].join("\n");
    const r = routerFrom(yaml).route({ file_paths: [], intent: "build" });
    expect(r.domains).toContain("maintainability");
    expect(Array.isArray(r.domains)).toBe(true);
    // Every domain must be a string — a corrupted tuple would surface as an object.
    for (const d of r.domains) expect(typeof d).toBe("string");
  });

  test("a flat top-level config parses (the original dead-parser bug)", () => {
    const yaml = [
      "routers:",
      "  - id: by-path",
      "    rules:",
      "      - if_match: '**/*.ts'",
      "        domains: [maintainability, error-handling]",
      "defaults:",
      "  domains: [maintainability, methodology]",
      "  max_rules_per_domain: 4",
      "  max_total_rules: 12",
    ].join("\n");
    const r = routerFrom(yaml).route({ file_paths: ["x.ts"], intent: "" });
    expect(r.domains).toContain("error-handling"); // would be absent if config parsed empty
  });
});
