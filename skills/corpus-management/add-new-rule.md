---
id: add-new-rule
title: Add a new rule to the BetterAI corpus
category: corpus-management
when_to_use: |
  When you've identified a recurring code-quality issue and want to capture it
  as a corpus rule so future agents stop making the same mistake. Trigger
  signals: you find yourself fixing the same anti-pattern across PRs; a code
  review keeps surfacing the same nit; a memory ("last time we tried X")
  hardens into a constraint ("never do X").
steps_count: 8
estimated_minutes: 20
applies_when:
  intents:
    - add rule
    - author rule
    - new rule
    - capture rule
codified_from: RULES.md migration § rule-authoring loop
related_rules:
  - simplicity-first
  - surgical-changes
related_skills:
  - deprecate-rule
created: 2026-06-09
---

## When to use this skill

Use this skill when a code-quality concern has crossed the "should be a rule"
threshold: it's recurring, it's checkable (even by a human reviewer), and the
remedy is short enough to fit in a single rule body. If you're tempted to
write a 400-line essay, it's probably a skill (procedure) or a memory
(episode), not a rule (constraint). Rules are the smallest unit; they answer
"don't do X because Y."

Do NOT use this skill for one-off issues, project-specific quirks, or rules
that contradict an existing rule without first reading the conflict-resolution
priority in the eng review.

## Prerequisites

- Repo cloned at `/Users/nicov/BetterAI` (or a worktree).
- `betterai` CLI on PATH (`npm run build && npm link` from the repo root).
- An example or two of the bad pattern, preferably already-merged code you can
  point at.
- A sense of the rule's `severity` (low = nit, medium = recurring waste,
  high = data-loss or security-shaped).

## Steps

1. **Pick `category` and `domain`.** Category is one of STANDARDS, PROCESS,
   PATTERNS, ARCHITECTURE, DOCUMENTATION. Domain is free-form lowercase
   kebab-case (e.g., `maintainability`, `error-handling`, `mcp-tooling`).
   The file lives at `rules/<CATEGORY>/<domain>/<id>.md`.
2. **Pick the `id`.** Kebab-case, unique across the whole corpus, short
   enough to type. Run `betterai list --json | jq -r '.[].id' | grep <stem>`
   to confirm it's not taken.
3. **Decide `severity`.** Low if a thoughtful reviewer would shrug; medium if
   it costs time over weeks; high if it leaks data, breaks prod, or makes the
   codebase actively worse to read. Severity drives retrieval ranking, so
   don't inflate.
4. **Define `applies_when`.** Add `paths` globs, `symbols` regex, and/or
   `intents` keywords so the MCP retriever can pre-filter. A rule with no
   `applies_when` will fire on every retrieval and quickly become noise.
5. **Write the six required body sections in order:** *What this rule says*,
   *Why it matters*, *When this applies*, *What good looks like* (with a
   concrete TypeScript code block), *Anti-patterns* (wrong example + fixed
   example), *Examples* (optional but recommended). Every section must be
   non-trivial — no placeholders.
6. **Add `related:` cross-links.** Skim sibling rules in the same domain. If
   your rule overlaps another, link it instead of restating; if it
   contradicts another, resolve via the priority order in the eng review.
7. **Validate via `betterai validate rules/<CATEGORY>/<domain>/<id>.md`.**
   This checks frontmatter, body sections, and that `related:` ids resolve.
   Fix any errors; do not commit a file that fails validation.
8. **Reload the server** with `betterai reload` (or restart the
   `betterai-server` container) so the new rule enters the retrieval index.
   Smoke-test by running a query you expect it to fire on.

## What good looks like

A new rule lands in under 20 minutes, fits on one screen, and the validator
passes on the first or second try. The retrieve smoke-test surfaces it for
the obvious query. Example shape of a freshly-authored frontmatter:

```typescript
// rules/STANDARDS/error-handling/no-silent-catch.md
const frontmatter = {
  id: "no-silent-catch",
  title: "Don't swallow exceptions without logging",
  category: "STANDARDS",
  domain: "error-handling",
  severity: "high",
  created: "2026-06-09",
  applies_when: {
    paths: ["src/**/*.ts"],
    symbols: "catch\\s*\\(",
    intents: ["error handling", "try catch"],
  },
  related: ["no-catch-all-exception-masking"],
};
```

## Common failure modes

- **Rule is actually a skill.** If the body reads like a how-to with numbered
  steps, stop — author it under `skills/` instead.
- **Severity inflation.** Marking everything `high` poisons retrieval ranking
  for the rules that actually deserve it.
- **No `applies_when`.** The rule fires on every query, becomes noise, and
  agents start ignoring the whole corpus.
- **Restating an existing rule.** Always grep the corpus first; cross-link
  via `related:` instead of duplicating.
- **Skipping the reload.** The file exists on disk but isn't in the index, so
  retrievals don't see it and you assume the rule "doesn't work."

## Related rules

- `simplicity-first` — keep rule bodies short; don't author a 400-line rule.
- `surgical-changes` — when adding a rule, don't refactor three others "while
  you're in there."
