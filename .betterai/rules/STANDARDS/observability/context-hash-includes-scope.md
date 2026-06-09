---
id: context-hash-includes-scope
title: Context hash must include scope and detected repo root
category: STANDARDS
domain: observability
severity: high
created: 2026-06-09
applies_when:
  paths: ["src/server/cache/**", "src/server/retrieve/**"]
  intents: ["implement cache", "retrieve_context", "review pr"]
related: [audit-must-include-parent-session]
---

## What this rule says

The `context_hash` used as the LRU cache key for retrieval responses MUST include the detected `repo_root` path and the `scopes_queried` array in its input. A hash that omits these fields lets two callers in two different repositories share a cache entry whenever their intent text happens to match — which is a cross-corpus poisoning bug.

The hash must be deterministic, stable under key ordering, and tested with a unit test that asserts two contexts identical in everything except `repo_root_detected` produce different hashes.

## Why it matters

The cache is shared across all callers of the MCP server on a single host. Without the scope fields in the hash key, this sequence is a cache-poisoning attack on yourself:

1. Agent A, working in repo X (a React app), retrieves rules for intent "add a new button component". The cache stores: `hash("add a new button component", [src/Button.tsx]) -> [react-rules-from-X]`.
2. Agent B, working in repo Y (a different React app with different repo-scoped rules), retrieves for the same intent text and a sibling-named file. The hash collides. Agent B gets repo X's rules.
3. The rules from repo X may contain things like "components live in `src/components/`" — false in repo Y. The agent follows them anyway.

The failure mode is subtle: the rules look plausible, the agent doesn't know they came from another repo, and the bug only manifests as "the agent keeps suggesting the wrong file layout." Hard to debug, security-adjacent because repo-scoped rules can encode credentials or internal-only conventions.

## When this applies

- Any change to the cache-key derivation in `src/server/cache/`.
- Any new caching layer added in front of `retrieve_context`, `retrieve_rules`, `retrieve_skills`, or `retrieve_memories`.
- Any refactor that changes the shape of the `Context` object passed to retrieval.
- Code review of any PR that introduces or modifies a `hash(...)` call in the retrieval path.

## What good looks like

The hash input is built from a frozen, sorted set of fields that explicitly includes the scope-determining ones. A unit test pins the invariant.

```ts
// src/server/cache/context-hash.ts
import { createHash } from "node:crypto";

export interface HashableContext {
  file_paths: string[];
  intent: string;
  symbols: string[];
  recent_diff: string;
  repo_root_detected: string | null;
  scopes_queried: ("global" | "repo")[];
}

export function contextHash(ctx: HashableContext): string {
  const canonical = JSON.stringify({
    file_paths: [...ctx.file_paths].sort(),
    intent: ctx.intent,
    symbols: [...ctx.symbols].sort(),
    recent_diff: ctx.recent_diff,
    repo_root_detected: ctx.repo_root_detected,
    scopes_queried: [...ctx.scopes_queried].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
```

The pinned test:

```ts
// src/server/cache/context-hash.test.ts
test("repo_root_detected changes the hash", () => {
  const base = {
    file_paths: ["src/Button.tsx"],
    intent: "add a new button component",
    symbols: [],
    recent_diff: "",
    scopes_queried: ["global", "repo"] as const,
  };
  const hashX = contextHash({ ...base, repo_root_detected: "/repos/X" });
  const hashY = contextHash({ ...base, repo_root_detected: "/repos/Y" });
  expect(hashX).not.toBe(hashY);
});
```

## Anti-patterns

Wrong — hash omits the scope fields entirely:

```ts
function contextHash(ctx) {
  return sha256(
    JSON.stringify({
      file_paths: ctx.file_paths,
      intent: ctx.intent,
      symbols: ctx.symbols,
      recent_diff: ctx.recent_diff,
      // MISSING: repo_root_detected, scopes_queried
    }),
  );
}
```

Wrong — fields are included but key order is not stable, so the same logical context hashes to different values across runs (and the cache is effectively disabled, which masks the poisoning bug until the cache is fixed and the poisoning re-emerges):

```ts
function contextHash(ctx) {
  return sha256(JSON.stringify(ctx)); // depends on V8's key insertion order
}
```

Fixed: see "What good looks like".

## Examples

```ts
// CORRECT: a retrieval call where the cache key is correctly scoped.
const ctx: HashableContext = {
  file_paths: req.body.context.file_paths,
  intent: req.body.context.intent,
  symbols: req.body.context.symbols ?? [],
  recent_diff: req.body.context.recent_diff ?? "",
  repo_root_detected: detectRepoRoot(req.body.context.file_paths),
  scopes_queried: req.body.scope === "global" ? ["global"] : ["global", "repo"],
};
const key = contextHash(ctx);
const cached = cache.get(key);
```
