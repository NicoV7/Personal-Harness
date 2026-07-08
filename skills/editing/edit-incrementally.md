---
id: edit-incrementally
title: Edit incrementally - one function-sized change per turn, then discuss
category: editing
forced: true
when_to_use: |
  Whenever you are implementing, editing, refactoring, or fixing code under
  the BetterAI harness with the incremental-edit gate active
  (BETTERAI_EDIT_GRANULARITY set to function or file). This skill is forced:
  it is injected on those intents regardless of retrieval score, because the
  gate will hard-deny a second mutation in the same turn and you need to know
  that before you batch edits.
steps_count: 5
estimated_minutes: 5
applies_when:
  intents:
    - implement
    - edit
    - refactor
    - fix
related_rules:
  - plans-enumerate-touch-set
related_skills:
  - write-scoped-plan
created: 2026-07-06
---

## When to use this skill

This skill applies when `BETTERAI_EDIT_GRANULARITY` is not `none`. In
`function` mode, make one function-sized edit per turn; in `file` mode, touch
at most one distinct file per turn. After that single edit, STOP and discuss
the result with the user - do not chain into the next edit. The edit-budget
gate enforces this: the second mutating tool call in the same turn (or the
second distinct file, in `file` mode) is denied with BAI-703 and the message
"stop and discuss with the user". In `none` mode the gate is inactive and
this skill does not constrain you.

## Prerequisites

- A plan with a `## Files to touch` manifest (see `write-scoped-plan`) - the
  manifest gate runs in the same chain, so know both budgets before editing.
- Know the current granularity: check `BETTERAI_EDIT_GRANULARITY` (explicit,
  no default) or ask the user which mode the session runs in.

## Steps

1. **Pick the single next edit.** Choose the smallest coherent unit: one
   function body, one new function, one config block - or one file in `file`
   mode. If the change you have in mind spans several functions, decompose it
   and pick the first.
2. **Make that one edit** with one Edit/Write call, inside the plan manifest.
3. **STOP.** End your turn by showing what changed and what you propose to do
   next. Do not issue a second mutating call - in active modes it will be
   denied with BAI-703, and a denial you predicted is a turn you wasted.
4. **Discuss.** Let the user confirm, redirect, or amend before continuing.
   The stopping is the feature: the gate exists to force conversation between
   increments, which is why the Stop hook never blocks in active modes.
5. **Continue on the next prompt.** Each new user prompt opens a fresh edit
   budget - the per-turn counters reset. Resume at step 1 for the next unit.

## What good looks like

A session transcript that alternates edit / short discussion / edit: every
turn contains exactly one mutation, each turn's message explains the
increment and names the next one, and BAI-703 never actually fires because
the agent budgeted its own turns. Review happens continuously instead of at
the end of a 40-file diff.

## Common failure modes

- **Batching "just two quick edits"** - the second call is denied (BAI-703),
  the turn ends in an error instead of a clean stop, and the discussion
  happens anyway but from a worse position.
- **Ending the turn without a proposal** - the user gets a bare diff and has
  to reconstruct your plan; always state the next intended increment.
- **Treating the denial as an obstacle to route around** (e.g. cramming
  multiple functions into one Write) - the granularity is a user decision;
  argue for `none` explicitly instead of gaming `function`.
- **Assuming a default granularity** - there is none; the setting is
  explicit. If it is unset, the boot fails loudly, not silently into `none`.

## Related rules

- `plans-enumerate-touch-set` - the companion gate: WHERE you may edit, while
  this skill governs HOW MUCH per turn.
