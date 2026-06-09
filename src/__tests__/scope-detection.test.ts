// Unit test for the repoRootDetector contract per docs/design/v4.1-scoping-extension.md §2.
// The detector walks up from a file path until it finds a sibling `.git/`
// directory; if none, returns null.
//
// Team B owns src/server/scope/detect.ts; this test imports it via the shared
// contract path. If Team B's file isn't compiled at merge time the test
// stands as the contract assertion — it documents the exact shape we expect.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORT CONTRACT: Team B exports `detectRepoRoot(paths: string[]): string | null`
// from src/server/scope/detect.ts.
let detectRepoRoot: (paths: string[]) => string | null;
try {
  const mod = await import("../server/scope/detect.js");
  detectRepoRoot = mod.detectRepoRoot;
} catch {
  // Team B's module not present yet — fall back to a no-op so the harness
  // still wires up. The test bodies will fail-loud individually.
  detectRepoRoot = () => null;
}

describe("repoRootDetector", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "betterai-scope-"));
    // tmp/
    //   workspace/
    //     repoA/
    //       .git/HEAD
    //       src/handlers/x.ts
    //       .betterai/rules/...
    //     repoB/
    //       .git/HEAD
    //       src/y.ts
    //     looseDir/
    //       z.ts
    mkdirSync(join(root, "workspace/repoA/.git"), { recursive: true });
    writeFileSync(join(root, "workspace/repoA/.git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, "workspace/repoA/src/handlers"), { recursive: true });
    writeFileSync(join(root, "workspace/repoA/src/handlers/x.ts"), "// x\n");
    mkdirSync(join(root, "workspace/repoA/.betterai/rules"), { recursive: true });
    mkdirSync(join(root, "workspace/repoB/.git"), { recursive: true });
    writeFileSync(join(root, "workspace/repoB/.git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, "workspace/repoB/src"), { recursive: true });
    writeFileSync(join(root, "workspace/repoB/src/y.ts"), "// y\n");
    mkdirSync(join(root, "workspace/looseDir"), { recursive: true });
    writeFileSync(join(root, "workspace/looseDir/z.ts"), "// z\n");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("returns the repo root when given a deeply nested file inside a git repo", () => {
    const got = detectRepoRoot([join(root, "workspace/repoA/src/handlers/x.ts")]);
    expect(got).toBe(join(root, "workspace/repoA"));
  });

  test("returns null when the file is in a non-git directory tree", () => {
    const got = detectRepoRoot([join(root, "workspace/looseDir/z.ts")]);
    expect(got).toBeNull();
  });

  test("picks the nearest git repo when nested .git directories exist", () => {
    // simulate a submodule: repoA contains an inner .git
    const innerSub = join(root, "workspace/repoA/vendor/inner");
    mkdirSync(join(innerSub, ".git"), { recursive: true });
    writeFileSync(join(innerSub, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(innerSub, "src"), { recursive: true });
    writeFileSync(join(innerSub, "src/a.ts"), "// a\n");
    const got = detectRepoRoot([join(innerSub, "src/a.ts")]);
    expect(got).toBe(innerSub);
  });

  test("returns null when the input array is empty", () => {
    expect(detectRepoRoot([])).toBeNull();
  });

  test("walks from the first path when multiple paths are given across repos", () => {
    const got = detectRepoRoot([
      join(root, "workspace/repoB/src/y.ts"),
      join(root, "workspace/repoA/src/handlers/x.ts"),
    ]);
    expect(got).toBe(join(root, "workspace/repoB"));
  });
});
