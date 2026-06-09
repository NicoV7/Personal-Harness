---
id: imports-at-top-not-deferred
title: Put imports at the top of the file; don't defer to dodge circular deps
category: STANDARDS
domain: error-handling
severity: low
created: 2026-06-09
applies_when:
  paths: ["**/*.ts", "**/*.js", "**/*.py"]
  intents: ["module-structure", "circular-imports", "defensive-programming"]
check:
  kind: ast-grep
  pattern: "function $F($$$) { $$$ require($_) $$$ }"
related:
  - no-catch-all-exception-masking
source: RULES.md §7 (bullet 4)
---

## What this rule says

Imports belong at the top of the file. If you find yourself moving a `require`, dynamic `import()`, or `from x import y` *inside* a function body to "break a circular import", you are papering over a module-graph design bug. Fix the graph, don't hide the cycle.

The legitimate exceptions are narrow and known: lazy-loading a giant optional dependency (a CLI subcommand's heavy module), conditional imports gated by feature flags, and the rare ES module / CommonJS interop dance. Cycle-breaking is not on that list.

## Why it matters

Deferred imports cost you:

- **Visibility.** Tools that read the dependency graph (bundlers, lint rules, IDE go-to-definition, dead-code detectors) see the top-level imports. Inline `require` is invisible to most of them.
- **Startup determinism.** A first-call `require` can throw on a missing module long after the process has started, often inside a request handler where the error becomes a user-facing 500.
- **A signal of deeper rot.** Circular imports almost always mean two modules want to be one module, or that a third shared module should be extracted. Inline imports hide that signal.

`severity: low` because the failure mode is "tech debt accumulates" rather than "data corrupts". But it accumulates fast: once one file inlines a `require`, others copy the pattern.

## When this applies

Applies when an import is moved inside a function specifically to dodge a `ReferenceError`, `ImportError`, or `Cannot access X before initialization`. The tell: the import sits inside the function, comments say "circular import" or "TODO: move to top", and the call site runs every time the function is invoked.

Does NOT apply to:

- Dynamic `import()` for code-splitting (e.g., `await import("./heavy-chart")` in a route handler that rarely fires).
- Lazy-loading optional plugins behind a flag.
- Test files that mock a module via `jest.isolateModules` or similar.

## What good looks like

When a cycle appears, extract the shared piece into a third module both sides can import from.

```typescript
// Before: a.ts imports b.ts, b.ts imports a.ts — cycle.
// File a.ts
import { B } from "./b";
export class A { b = new B(); }

// File b.ts
import { A } from "./a";
export class B { a?: A; }
```

```typescript
// After: extract the shared type into c.ts. Cycle gone.
// File c.ts
export interface Node { id: string; }

// File a.ts
import type { Node } from "./c";
import { B } from "./b";
export class A implements Node { id = "a"; b = new B(); }

// File b.ts
import type { Node } from "./c";
export class B implements Node { id = "b"; }
```

Top-level imports stay at the top. The cycle is gone because there is no longer a cycle to break.

## Anti-patterns

Deferred imports used as a cycle workaround:

```typescript
// BAD — inline require to dodge a circular import.
export function renderReport(data: Data) {
  const { formatTable } = require("./formatter"); // "circular import, see #1234"
  return formatTable(data);
}
```

What's wrong:

1. The bundler can't tree-shake `./formatter`.
2. The first call to `renderReport` after a deploy may throw `MODULE_NOT_FOUND` from a path bug that would have been caught at startup.
3. The comment `// circular import` documents the smell instead of fixing it.

The fix is to move the import to the top *and* untangle the cycle (extract a third file, invert a dependency, or merge the two files if they really are one concept):

```typescript
import { formatTable } from "./formatter";

export function renderReport(data: Data) {
  return formatTable(data);
}
```

If the cycle won't yield to extraction, the real answer is usually that the two files want to be one — merge them.
