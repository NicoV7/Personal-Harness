// src/__tests__/frontmatter-robustness.test.ts
//
// G12 — corpus-load robustness against malformed frontmatter.
//
// Contract under test (pinned to the CURRENT reader behavior, per
// src/corpus/reader.ts): a shape-invalid artifact is DROPPED with a
// ValidationIssue recorded on the snapshot — never normalized silently,
// never thrown.  A malformed file must not prevent its valid siblings from
// loading, and a 100%-invalid corpus must still yield a bootable (empty)
// snapshot.
//
// All fixtures live in real tmpdirs (no repo-state or network dependence).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorpusReader } from "../corpus/reader.js";
import type { CorpusSnapshot } from "../corpus/reader.js";

// ---- Fixture helpers -----------------------------------------------------

function writeArtifact(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function validRule(id: string, extraFrontmatter = ""): string {
  return [
    "---",
    `id: ${id}`,
    `title: Valid rule ${id}`,
    "category: STANDARDS",
    "domain: testing",
    "severity: low",
    "created: 2026-06-10",
    ...(extraFrontmatter ? [extraFrontmatter] : []),
    "---",
    "",
    "## What this rule says",
    "",
    `Body of ${id}.`,
    "",
  ].join("\n");
}

const RULE_REL = (id: string): string => `rules/STANDARDS/testing/${id}.md`;

// ---- Suite ---------------------------------------------------------------

describe("frontmatter robustness (G12)", () => {
  let globalRoot: string;
  let repoRoot: string;

  beforeEach(() => {
    globalRoot = mkdtempSync(join(tmpdir(), "betterai-g12-global-"));
    repoRoot = mkdtempSync(join(tmpdir(), "betterai-g12-repo-"));
  });

  afterEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function read(): CorpusSnapshot {
    return new CorpusReader({ globalRoot, repoRoot }).read();
  }

  it("drops a rule whose applies_when.paths is a string, with a logged warning", () => {
    writeArtifact(
      globalRoot,
      RULE_REL("string-paths"),
      validRule("string-paths", 'applies_when:\n  paths: "src/**"'),
    );
    writeArtifact(globalRoot, RULE_REL("healthy"), validRule("healthy"));

    const snap = read();

    // Dropped, not normalized: the invalid rule must not appear.
    expect(snap.rules.map((r) => r.id)).toEqual(["healthy"]);
    // ...and the drop is loud: exactly one issue naming the bad field.
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0].kind).toBe("rule");
    expect(snap.issues[0].path).toContain("string-paths.md");
    expect(snap.issues[0].message).toContain("applies_when.paths");
  });

  it("does not crash on null applies_when.intents; drops with a warning", () => {
    writeArtifact(
      globalRoot,
      RULE_REL("null-intents"),
      validRule("null-intents", "applies_when:\n  intents: null"),
    );
    writeArtifact(globalRoot, RULE_REL("healthy"), validRule("healthy"));

    let snap: CorpusSnapshot | undefined;
    expect(() => {
      snap = read();
    }).not.toThrow();

    expect(snap!.rules.map((r) => r.id)).toEqual(["healthy"]);
    expect(snap!.issues).toHaveLength(1);
    expect(snap!.issues[0].message).toContain("applies_when.intents");
  });

  it("skips a file with no frontmatter at all and keeps loading", () => {
    writeArtifact(
      globalRoot,
      RULE_REL("no-frontmatter"),
      "# Just a markdown file\n\nNo YAML fence anywhere.\n",
    );
    writeArtifact(globalRoot, RULE_REL("healthy"), validRule("healthy"));

    const snap = read();

    expect(snap.rules.map((r) => r.id)).toEqual(["healthy"]);
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0].path).toContain("no-frontmatter.md");
    expect(snap.issues[0].message).toBe("no frontmatter found");
  });

  it("returns an empty, bootable snapshot for a 100%-invalid corpus without throwing", () => {
    writeArtifact(
      globalRoot,
      RULE_REL("bad-rule"),
      validRule("bad-rule", "applies_when:\n  paths: null"),
    );
    writeArtifact(
      globalRoot,
      "skills/testing/bad-skill.md",
      "---\nid: bad-skill\n---\n\nMissing every other required field.\n",
    );
    writeArtifact(
      globalRoot,
      "memories/2026-06/bad-memory.md",
      "No frontmatter at all.\n",
    );

    let snap: CorpusSnapshot | undefined;
    expect(() => {
      snap = read();
    }).not.toThrow();

    // Empty corpus, fully-formed snapshot shape: the server can boot on it.
    expect(snap!.rules).toEqual([]);
    expect(snap!.skills).toEqual([]);
    expect(snap!.memories).toEqual([]);
    expect(snap!.overridden_global_ids).toEqual([]);
    expect(snap!.scopes_loaded).toContain("global");
    expect(snap!.issues).toHaveLength(3);
  });

  it("applies a valid repo artifact even when the same-id global artifact is invalid", () => {
    const id = "shared-id";
    // Global copy: shape-invalid (string where array) => dropped at load.
    writeArtifact(
      globalRoot,
      RULE_REL(id),
      validRule(id, 'applies_when:\n  intents: "review pr"'),
    );
    // Repo copy: valid override with the same id.
    writeArtifact(repoRoot, RULE_REL(id), validRule(id));

    const snap = read();

    const winner = snap.rules.filter((r) => r.id === id);
    expect(winner).toHaveLength(1);
    expect(winner[0].scope).toBe("repo");
    // The invalid global never made it into the merge, so it is reported
    // as a validation issue rather than as an override.
    expect(snap.overridden_global_ids).toEqual([]);
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0].path).toContain(`${id}.md`);
  });

  // ---- Wave-1 regression: the real seed-corpus shapes parse to arrays ----

  it("parses nested block lists and inline flow arrays in applies_when", () => {
    writeArtifact(
      globalRoot,
      RULE_REL("block-list"),
      validRule(
        "block-list",
        "applies_when:\n  paths:\n    - \"src/**/*.ts\"\n    - tests/**\n  intents:\n    - plan\n    - design",
      ),
    );
    writeArtifact(
      globalRoot,
      RULE_REL("flow-list"),
      validRule(
        "flow-list",
        'applies_when:\n  paths: ["**/*.ts", "**/*.py"]\n  intents: [review pr]',
      ),
    );

    const snap = read();

    expect(snap.issues).toEqual([]);
    const block = snap.rules.find((r) => r.id === "block-list");
    expect(block?.applies_when?.paths).toEqual(["src/**/*.ts", "tests/**"]);
    expect(block?.applies_when?.intents).toEqual(["plan", "design"]);
    const flow = snap.rules.find((r) => r.id === "flow-list");
    expect(flow?.applies_when?.paths).toEqual(["**/*.ts", "**/*.py"]);
    expect(flow?.applies_when?.intents).toEqual(["review pr"]);
  });

  it("parses an empty inline array as [], not [null]", () => {
    writeArtifact(
      globalRoot,
      "memories/2026-06/empty-related.md",
      [
        "---",
        "id: empty-related",
        "title: Memory with an empty related_rules list",
        "date: 2026-06-10",
        "project: betterai",
        "kind: decision",
        "context_keywords: [testing]",
        "durability: short",
        "auto_captured: false",
        "related_rules: []",
        "---",
        "",
        "## What happened",
        "",
        "Nothing of note.",
        "",
      ].join("\n"),
    );

    const snap = read();

    expect(snap.issues).toEqual([]);
    expect(snap.memories).toHaveLength(1);
    expect(snap.memories[0].related_rules).toEqual([]);
  });

  it("loads the repo-root global seed corpus with zero validation issues", () => {
    // Guard against Wave-1 regressions in the seed corpus itself: every
    // artifact under <repo>/rules|skills|memories must validate cleanly.
    const seedRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const snap = new CorpusReader({ globalRoot: seedRoot }).read();

    expect(snap.issues).toEqual([]);
    expect(snap.rules.length).toBeGreaterThan(0);
    expect(snap.skills.length).toBeGreaterThan(0);
    expect(snap.memories.length).toBeGreaterThan(0);
  });
});
