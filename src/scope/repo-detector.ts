// src/scope/repo-detector.ts
//
// Repo-root walk-up + .betterai/ presence check, with a 60s mtime-keyed
// cache.
//
// Per v4.1-scoping-extension §2:
//   - Walk up parent directories until we find a .git/ entry.
//   - That host directory is the repo root.
//   - Check <repo-root>/.betterai/ exists AS A DIRECTORY (not regular
//     file, not dangling symlink).
//   - Cache the (prefix → repo_root) mapping for 60s, keyed by
//     mtime(.git/HEAD) so branch switches invalidate cleanly.
//
// Inputs are HOST paths; the server reads the filesystem via the
// `~/projects:/projects:ro` mount so the same on-disk inode is reachable
// inside the container.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  MAX_WALK_UP_DEPTH,
  REPO_DETECT_CACHE_TTL_MS,
} from "../constants/scope.js";

export interface RepoDetection {
  repo_root: string | null;
  has_betterai_dir: boolean;
  /** mtime(.git/HEAD) at detection time, used for cache invalidation. */
  git_head_mtime_ms: number | null;
}

export interface RepoDetectorOptions {
  ttlMs?: number;
  /** Stop ascending here (defaults: filesystem root and "$HOME"). */
  stopAt?: string[];
  /** Clock injection for tests. */
  now?: () => number;
}

interface CacheEntry {
  detection: RepoDetection;
  cachedAtMs: number;
  /** mtime captured at cache time; if it changes, the entry is stale. */
  gitHeadMtimeMs: number | null;
}

/**
 * Repo-root detector with a per-host-path-prefix cache.
 *
 * The cache stores one entry per *resolved* repo root, plus a separate
 * per-input-prefix index so repeat calls from any file inside the same
 * repo are O(1).  Not premature optimization — every retrieve_context
 * call passes through this and many calls share a prefix.
 */
export class RepoDetector {
  private readonly ttlMs: number;
  private readonly stopAt: Set<string>;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: RepoDetectorOptions = {}) {
    this.ttlMs = opts.ttlMs ?? REPO_DETECT_CACHE_TTL_MS;
    this.stopAt = new Set(
      (opts.stopAt ?? ["/", process.env.HOME ?? "/"]).map((p) => resolve(p)),
    );
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Detect the repo root for a single host path.  Returns
   * `{ repo_root: null }` if no `.git/` is found.
   */
  detect(hostPath: string): RepoDetection {
    const start = resolve(hostPath);
    const cached = this.cache.get(start);
    if (cached) {
      const fresh = this.now() - cached.cachedAtMs < this.ttlMs;
      const stillValid =
        fresh &&
        currentHeadMtime(cached.detection.repo_root) === cached.gitHeadMtimeMs;
      if (stillValid) return cached.detection;
      this.cache.delete(start);
    }
    const detection = this.walkUp(start);
    this.cache.set(start, {
      detection,
      cachedAtMs: this.now(),
      gitHeadMtimeMs: detection.git_head_mtime_ms,
    });
    return detection;
  }

  /**
   * Detect a single repo root for a batch of host paths.  Per
   * v4.1-scoping-extension §2, we use file_paths[0] as the source of
   * truth (a multi-file context is assumed to live in one repo; rare
   * cross-repo edits get the first path's repo).
   */
  detectFromBatch(hostPaths: string[]): RepoDetection {
    if (!hostPaths.length) {
      return { repo_root: null, has_betterai_dir: false, git_head_mtime_ms: null };
    }
    return this.detect(hostPaths[0]);
  }

  private walkUp(start: string): RepoDetection {
    let dir = isDirectory(start) ? start : dirname(start);
    // Cap the walk so a runaway symlink can't loop forever.
    for (let i = 0; i < MAX_WALK_UP_DEPTH; i += 1) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const betterai = join(dir, ".betterai");
        const has = isDirectory(betterai);
        return {
          repo_root: dir,
          has_betterai_dir: has,
          git_head_mtime_ms: currentHeadMtime(dir),
        };
      }
      if (this.stopAt.has(dir)) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { repo_root: null, has_betterai_dir: false, git_head_mtime_ms: null };
  }
}

// Local helpers — kept module-private to avoid polluting the import
// surface.  The path manipulation below uses node's posix-like resolve
// so it works on macOS + Linux; Windows is documented as Phase 1.5.

function join(a: string, b: string): string {
  if (a.endsWith(sep)) return a + b;
  return a + sep + b;
}

function isDirectory(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function currentHeadMtime(repoRoot: string | null): number | null {
  if (!repoRoot) return null;
  try {
    const st = statSync(join(join(repoRoot, ".git"), "HEAD"));
    return st.mtimeMs;
  } catch {
    return null;
  }
}
