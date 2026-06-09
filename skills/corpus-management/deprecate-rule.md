---
id: deprecate-rule
title: Deprecate a corpus rule that no longer applies
category: corpus-management
when_to_use: |
  When a rule no longer applies (the framework migrated away, the anti-pattern
  was made syntactically impossible by tooling, the underlying assumption is
  wrong) or has been superseded by a sharper rule. Trigger signals: `fire_count`
  is flat for months despite plenty of matching code; the rule keeps getting
  contested in PR review; a newer rule covers the same ground better.
steps_count: 5
estimated_minutes: 10
applies_when:
  intents:
    - deprecate
    - retire rule
    - remove rule
    - sunset rule
related_rules:
  - simplicity-first
related_skills:
  - add-new-rule
created: 2026-06-09
---

## When to use this skill

Use when you've decided a rule has outlived its usefulness. Deprecation is
the gentle option — the rule keeps existing for 30 days (so retrieval history
and `related:` pointers don't break) but no longer fires in new contexts.
Hard-delete only after the grace period.

Do NOT deprecate a rule just because it's annoying or you disagreed with it
in one PR. Check `fire_count` and `last_fired` first; if it's still firing on
real code, it's still doing its job.

## Prerequisites

- `betterai` CLI available, with access to the rule's stats
  (`betterai stats <id>` shows `fire_count` and `last_fired`).
- Write access to the corpus directory.
- Knowledge of which other rules link to this one via `related:` (find with
  `grep -lr "related:.*<id>" rules/`).

## Steps

1. **Confirm via `fire_count` history.** Run `betterai stats <rule-id>`. If
   `fire_count > 0` in the last 30 days, the rule is still doing useful work —
   do not deprecate. If it's flat or zero despite the code patterns it targets
   still existing, proceed.
2. **Mark frontmatter `status: deprecated`** and add `deprecated_on:
   2026-06-09` (today's date). Do NOT delete the file yet — the 30-day grace
   period preserves `related:` pointers from other rules and audit-trail
   referenceability.
3. **Add a deprecation note at the top of the body**, before *What this rule
   says*: `> **DEPRECATED 2026-06-09.** Superseded by [<new-rule-id>] /
   No longer applies because <reason>. See `_deprecated/` after 2026-07-09.`
4. **Update `related:` pointers from other rules.** For each rule that links
   to this one, either remove the link (if the relationship is gone) or
   repoint to the superseding rule. Do this BEFORE the move so dangling refs
   don't appear in validator output.
5. **Move the file to `rules/_deprecated/<original-path>/<id>.md` after 30
   days.** Set a calendar reminder; on the move, run `betterai reload` so the
   retriever drops it from the live index. The file stays on disk
   indefinitely for archaeology.

## What good looks like

A deprecated rule's frontmatter clearly signals its status, the body's first
paragraph tells future-you why it was retired, and no live rule links to it
without going through the superseding rule. Example deprecation block:

```typescript
// rules/STANDARDS/error-handling/old-rule.md frontmatter delta
const deprecationFields = {
  status: "deprecated",
  deprecated_on: "2026-06-09",
  superseded_by: "no-catch-all-exception-masking",
};
// Body opens with:
// > DEPRECATED 2026-06-09. Superseded by no-catch-all-exception-masking.
// > The new rule is sharper because it distinguishes intentional rethrows.
```

## Common failure modes

- **Deleting instead of deprecating.** Hard-delete breaks `related:` links
  in other rules and erases the audit trail.
- **Skipping the grace period.** Moving to `_deprecated/` on day 0 causes
  validators to complain about dangling references.
- **Not updating linkers.** Other rules still point at the deprecated rule
  and surface stale context to the retriever.
- **Deprecating a rule that's still firing.** Check stats first; if it's
  firing on real code, the rule is right and your discomfort is wrong.
- **Forgetting to reload.** The deprecated rule keeps appearing in retrieval
  results because the server's index wasn't refreshed.

## Related rules

- `simplicity-first` — a smaller corpus retrieves better; sunset aggressively
  once a rule is dead weight.
