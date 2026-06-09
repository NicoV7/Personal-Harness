/**
 * Walk up from a starting directory to find the nearest git repo root.
 *
 * Mirrors the v4.1 scoping detection logic, but runs entirely in the CLI
 * process — no container needed. Returns null if we walk to '/' without
 * finding a .git/ entry.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function detectRepoRoot(start: string): string | null {
  let dir = resolve(start);
  // Guard against pathological inputs (no parent).
  for (let i = 0; i < 64; i++) {
    const gitPath = `${dir}/.git`;
    if (existsSync(gitPath)) {
      // .git is usually a dir, but in worktrees it's a file pointing at the
      // real gitdir. Both count for "this is a repo root".
      const st = statSync(gitPath);
      if (st.isDirectory() || st.isFile()) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
