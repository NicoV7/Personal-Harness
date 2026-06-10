# TODO: Strictness Sweep (deferred to v1.5 Item 6)

Tracked in the v1.5 design doc and Wave 5 specialist Y handoff.

## Why

Wave 5 relaxed three `tsconfig.json` flags to unblock the Phase 1.0 compile
gate without a 1–2 day systematic strictness rewrite:

- `noPropertyAccessFromIndexSignature: false`
- `noUncheckedIndexedAccess: false`
- `exactOptionalPropertyTypes: false`

`strict: true` plus the other twelve strictness flags stay on. The three
relaxed flags currently silence ~157 stylistic call-site errors with **no
known behavioral bugs**. This file maps where those errors would re-fire if
the flags are re-enabled, so v1.5 Item 6 has a punch-list instead of a search.

Counts below are from the pre-relax `npm run typecheck` baseline captured
on 2026-06-09 (251 total errors → 95 after relax → 30 contract-only after
the Wave 5 tool rewrite).

## Pattern: noPropertyAccessFromIndexSignature (TS4111, 74 sites)

When the relaxation flips off, every `obj.foo` against an object typed as
`Record<string, T>` (or `process.env`) becomes a hard error. The fix is
**either** bracket-access (`obj['foo']`) **or** narrow the type so the
property is declared explicitly. Prefer narrowing — the bracket-access form
silently masks typos.

### Sites by file

- `src/_meta-validators/rule-schema.ts` — 29 sites. The frontmatter parser
  treats every parsed YAML node as `Record<string, unknown>`. The clean
  fix is a Zod-validated narrowed type per artifact kind.
- `src/cli/validate.ts` — 19 sites. Same root cause; consumes the
  validator's parsed-frontmatter shape.
- `src/cli/why.ts` — 6 sites. Reads audit JSONL records as
  `Record<string, unknown>`. Define an `AuditRecord` type and parse with
  Zod at the boundary.
- `src/cli/replay.ts` — 5 sites. Same audit-record shape.
- `src/cli/status.ts` — 3 sites.
- `src/cli/init.ts` — 3 sites.
- `src/cli/gate.ts` — 3 sites.
- `src/server/retrieve/router.ts` — 2 sites. Domain-router YAML access.
- `src/cli/new.ts` — 2 sites.
- `src/cli/main.ts` — 1 site.
- `src/server/scope/repo-detector.ts` — 1 site (`process.env.HOME`).

## Pattern: noUncheckedIndexedAccess (TS18048 / TS2532 / TS2538, 60 sites)

Re-enabling makes every `arr[i]` and `map.get(k)` produce `T | undefined`.
The disciplined fix is an `assertDefined<T>(v: T | undefined, msg: string): T`
helper used at every loop / parse / cache-hit boundary. Do **not** scatter
non-null assertions (`!`) — they delete the safety net the flag is buying.

### Sites by file

- `src/server/corpus/reader.ts` — 16 sites. Walker + frontmatter parser
  both index into arrays / regex match groups without a default. Several
  of these can collapse if `parseDoc` returns a discriminated union and
  the walkers refactor to `for…of` over entries that include null checks.
- `src/_meta-validators/rule-schema.ts` — 15 sites. Same root cause as the
  TS4111 cluster; an Item 6 rewrite that narrows the frontmatter type
  also kills these.
- `src/cli/_shared/frontmatter.ts` — 13 sites. Hand-rolled parser; will
  resolve when the parser swaps to the `yaml` package (already TODO'd in
  `src/server/corpus/reader.ts:204`).
- `src/server/retrieve/router.ts` — 11 sites. Domain-router list/regex
  access — small surface, easy to add an `assertDefined` at the regex
  group boundary.
- `src/mcp-tools/retrieve-{rules,skills,memories}.ts` — 1 site each (3
  total). Cache-hit code paths reading `cached.payload` need a guard once
  X's `CachedRetrieval<T>` envelope is in place; the current code already
  unwraps `.payload` so these may resolve at merge.
- `src/cli/why.ts` — 1 site.
- `src/cli/main.ts` — 1 site.

## Pattern: exactOptionalPropertyTypes (TS2379 / TS2353, 10 sites)

Re-enabling means `{ x?: T }` cannot accept `{ x: undefined }` — you have
to omit the key or change the type to `{ x?: T | undefined }`. The fix is
mechanical (drop the explicit `undefined` assignment or widen the type)
but easy to get wrong on optional-with-default codepaths.

### Sites by file

- `src/mcp-tools/*.ts` — 7 sites. Every tool currently builds the
  `AuditEvent` with literal-`null` optionals; once X lands `cache_hit?:
  boolean` and any other optional audit fields, audit it once for any
  `undefined` writes vs explicit-omit.
- `src/server/corpus/reader.ts` — 3 sites. Frontmatter parser writes
  `applies_when: undefined` onto records whose type declares
  `applies_when?: AppliesWhenT`. Either narrow the spread or change the
  field to `applies_when?: AppliesWhenT | undefined`.

## How to take this on (Item 6 recipe)

1. Flip the three flags back to `true` in `tsconfig.json`.
2. Run `npm run typecheck` — expect ~150 errors.
3. Start with the TS4111 cluster — it's the largest and the cleanest
   single-pattern fix (narrow types at the parse boundary).
4. Add `src/server/_shared/assertDefined.ts` with the helper and a unit
   test. Use it at every TS18048 / TS2538 site.
5. Walk the TS2379 / TS2353 sites last — they're the fewest and depend on
   the audit-event shape being stable.
6. Re-run typecheck. Target zero errors. Re-run `npm test`. Target zero
   regressions.

## Anti-patterns to avoid in the sweep

- **Don't** spray `!` non-null assertions. They silently shift the bug
  forward instead of fixing it.
- **Don't** widen optional fields to `T | undefined` everywhere — only
  where the data flow genuinely allows an undefined write.
- **Don't** bracket-access `process.env` and call it done; narrow via the
  Zod env-schema that already exists in `src/server/main.ts`.
- **Don't** sweep CLI verbs and the validator in the same PR — they're
  independent surfaces and will produce a huge unreviewable diff. Split
  by file cluster.
