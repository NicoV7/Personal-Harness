---
id: run-betterai-eval
title: Run the weekly betterai eval gate before closing a dogfooding day
category: release
when_to_use: |
  Before declaring a Phase 1.0 dogfooding day complete, run `betterai eval`
  for the weekly digest. The gate checks whether rules are actually firing
  on real agent activity and whether behavior is changing in the expected
  direction. Trigger signals: end of a coding day on betterai; end-of-week
  retro; right before a corpus version bump.
steps_count: 4
estimated_minutes: 5
applies_when:
  intents:
    - evaluate
    - gate
    - ship
    - dogfood
    - weekly digest
related_rules:
  - goal-driven-execution
related_skills:
  - add-new-rule
  - deprecate-rule
created: 2026-06-09
---

## When to use this skill

Use this at the end of any dogfooding day in Phase 1.0, and always before a
weekly corpus version bump. The gate is the ground truth for "is the corpus
actually doing its job?" — without running it you're flying blind on whether
the rules you authored last week ever fired.

Do NOT use this skill mid-day or as a "is my rule live?" check; that's what
`betterai retrieve --dry-run` is for. The gate is a digest, not a probe.

## Prerequisites

- Audit JSONL files present in `audit/` for the week being evaluated.
- `betterai` CLI on PATH at the matching corpus version.
- Dogfooding log at `~/.gstack/projects/betterai/dogfooding-log.md`
  (created on first run if absent).

## Steps

1. **Run `betterai gate --week N`** where N is the ISO week number. The
   command reads `audit/`, computes fire counts per rule, compares against
   the prior week, and prints a PASS/FAIL banner plus a digest table.
2. **Read the PASS/FAIL output.** PASS means: at least 80% of medium+ rules
   fired at least once, no rule has gone 3+ weeks dark, behavior-change
   metric trended in the expected direction. FAIL surfaces a list of failing
   criteria with exact counts.
3. **If FAIL, inspect the missing criteria** (fires count, behavior
   changes). For each dark rule, decide: is the rule wrong (deprecate via
   the `deprecate-rule` skill), is `applies_when` too narrow (loosen it), or
   has the project just not exercised that code path this week (note and
   move on). Do not edit rules to game the gate — the gate is a signal, not
   a target.
4. **Append a daily entry to `~/.gstack/projects/betterai/dogfooding-log.md`.**
   The entry has: date, PASS/FAIL, top 3 firing rules, any new rules
   authored today, any rules deprecated, one sentence on the most useful
   retrieval of the day. This log is the input to the weekly retro.

## What good looks like

A 5-minute end-of-day ritual that produces a one-line log entry on a green
day and a short paragraph on a red day. Example invocation and log entry:

```typescript
// shell session
// $ betterai gate --week 23
// PASS  week=23  rules_evaluated=42  fires=137  behavior_delta=+12%
// top firing: no-catch-all-exception-masking (18), simplicity-first (14)

// ~/.gstack/projects/betterai/dogfooding-log.md
const logEntry = `
## 2026-06-09 — PASS
- top fires: no-catch-all-exception-masking (18), simplicity-first (14), surgical-changes (9)
- new rules: add-mcp-tool authored; no rules deprecated
- best retrieval: simplicity-first fired on the eval CLI scope creep PR and we cut 60 LOC
`;
```

## Common failure modes

- **Running it without audit data.** The gate prints PASS trivially because
  there's nothing to fail on. Confirm `audit/<this-week>.jsonl` exists and
  is non-empty before trusting the result.
- **Editing rules to game the gate.** If a rule isn't firing, the answer is
  almost never to lower its severity or broaden `applies_when` until it
  does. The honest answer is usually "this code path didn't come up."
- **Skipping the log entry.** The weekly retro has nothing to look at; the
  gate's value compounds via the log, not the moment-of-run output.
- **Running it once a week instead of daily.** Daily entries are how you
  notice a slow drift; weekly-only misses the gradient.

## Related rules

- `goal-driven-execution` — the gate measures whether the corpus is
  achieving its goal (behavior change), not just whether rules exist on
  disk.
