// src/scope/detect.ts
//
// Functional facade over RepoDetector for callers (MCP tools, tests) that
// just want "given these paths, where's the repo root?". Keeps the class
// (with its cache + walk-up state) and adds a tiny stateless entry point.
//
// Contract: see docs/design/v4.1-scoping-extension.md §2.
//
//   detectRepoRoot([])          → null
//   detectRepoRoot([nestedFile]) → "/abs/path/to/repo-root"
//   detectRepoRoot([fileNoGit]) → null
//
// We use the FIRST path as the source of truth per v4.1 §2 — a multi-file
// retrieval context is assumed to live in a single repo, and rare
// cross-repo edits inherit the first path's repo.

import { RepoDetector } from "./repo-detector.js";

/**
 * Stateless wrapper over RepoDetector.detectFromBatch().
 *
 * Each call constructs a fresh detector so we don't share cache state
 * across callers that may not want it. Tools that need the per-prefix
 * cache should hold their own RepoDetector instance (the DI ctx already
 * carries one as `ctx.repoRootDetector`).
 */
export function detectRepoRoot(paths: string[]): string | null {
  const detector = new RepoDetector();
  const detection = detector.detectFromBatch(paths);
  return detection.repo_root ?? null;
}
