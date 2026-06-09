---
id: no-god-files
title: Avoid GOD files — flag any source file over 2000 LOC for refactor
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-06-09
applies_when:
  paths:
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
related:
  - simplicity-first
  - ask-about-non-functionals
check:
  kind: regex
  pattern: "^"
  notes: "Linecount check; enforced by tooling, not regex. This entry is a hint."
---

## What this rule says

Any single source file that exceeds **2000 lines of code** is a "GOD file" and
must be heavily considered for a refactor before further additions land. The
threshold is a soft trigger, not a hard wall: it means the file warrants
explicit scrutiny — does it have one cohesive responsibility, or has it
become a dumping ground?

When you're about to add code to a file already at or near 2000 LOC, the
default answer is "split first, add second." Adding to a GOD file without
questioning the structure perpetuates the problem.

## Why it matters

Files over 2000 LOC are a reliable signal of accumulated complexity that no
one has paid down. They cause concrete, measurable harm:

- **Cognition cost:** humans and LLM agents both struggle to hold the whole
  file in working memory. Context windows truncate, search is slower,
  navigation breaks down.
- **Hidden coupling:** unrelated concerns end up in the same file because
  "there's already a function that does *almost* this." Cross-cutting changes
  ripple unpredictably.
- **Test and review pain:** diffs against GOD files are hard to review,
  blast radius is unclear, and unit tests are forced to mock huge surface
  areas.
- **Merge conflicts:** parallel work on the same mega-file conflicts
  constantly.

The 2000 LOC number isn't magic, but it's a reliable Schelling point — files
above it are almost always doing too many things.

## When this applies

- Before adding a non-trivial change to a file already ≥ 1800 LOC: pause and
  ask whether the file should be split first.
- During design/planning for a new module: if the proposed shape would
  obviously produce a 2000+ LOC file, layer it up front (per the
  service/models/dtos/tests/tools/constants/handlers layering convention).
- During code review: flag any new file authored above the threshold, and
  flag any PR that pushes an existing file across the threshold.

Does NOT apply to:

- Generated code (e.g., types from OpenAPI, `*.gen.ts`) — they're not
  hand-edited.
- Lockfiles, fixtures, snapshots — not source code.
- Single-file vendor drops that the project deliberately doesn't modify.

## What good looks like

A 2400-line `userService.ts` is split into cohesive siblings before new
features land:

```
src/services/user/
  userService.ts            // 380 LOC — public API surface
  userQueries.ts            // 420 LOC — database reads
  userCommands.ts           // 510 LOC — database writes / mutations
  userValidation.ts         // 280 LOC — Zod schemas + validators
  userEvents.ts             // 240 LOC — event emission
  index.ts                  // 12 LOC — re-exports
```

Each file has one reason to change. New work targets the right file directly,
and a reviewer can hold the relevant file in their head.

When you do need to add code and a file is right under the limit, leave a
short note: `// TODO(refactor): this file is at 1850 LOC; split userQueries
out before adding more read paths.`

## Anti-patterns

Adding "just one more handler" to a 2300-line `apiHandlers.ts` because it's
"easier than refactoring right now." This is exactly how files get to 4000
LOC. The marginal cost of splitting now is roughly constant; the cost grows
with every deferred refactor.

```ts
// Anti-pattern: ninth unrelated handler glued onto an already-bloated file.
// apiHandlers.ts is 2310 LOC. This PR adds 80 more.
export async function handlePaymentWebhook(req: Request, res: Response) {
  /* ... unrelated to the other 8 handlers, but parked here anyway ... */
}
```

Fix: pull the new handler (and likely 1–2 sibling handlers it's conceptually
near) into a new file, e.g., `paymentHandlers.ts`, then add the new code
there. The PR grows slightly but the codebase improves.

The other common anti-pattern is "barrel-file as GOD file" — a single
`index.ts` that re-exports everything *and* contains real logic. The barrel
should be a thin re-export only.

## Examples

A practical workflow when you trip the threshold:

1. Identify the natural seams in the file (often: queries vs. commands,
   schemas vs. logic, HTTP layer vs. domain layer).
2. Move one cohesive cluster to a new sibling file.
3. Keep the original file's public API stable via re-exports during the
   transition.
4. Run the full test suite — if it still passes, the split was clean.
5. Then make the originally-requested change in the appropriately-sized file.

If under time pressure, at minimum leave a `TODO(refactor)` comment naming
the seam, so the next agent has a concrete starting point.
