---
id: plans-enumerate-touch-set
title: Plans enumerate the exact files and functions they will touch
category: PROCESS
domain: methodology
severity: medium
created: 2026-07-06
applies_when:
  intents:
    - plan
    - design
    - propose
    - architecture
    - implement
related:
  - surgical-changes
  - prefer-existing-tools
---

## What this rule says

Every implementation plan must contain a `## Files to touch` section that
enumerates each file the change will create or modify, with the functions or
symbols affected in that file. Implementation then stays within that set: if
work reveals a file the plan missed, the plan is amended (or the deviation is
explicitly justified) before the edit happens - the touch set is a contract,
not a suggestion.

## Why it matters

Scope creep is the default failure mode of agent implementation: a fix in one
module becomes a refactor of three, a rename cascades into twenty files, and
the reviewer can no longer tell the intended change from the incidental one.
This is the working-set form of `surgical-changes`: naming the touch set up
front makes creep visible at the moment it happens instead of at review time.
It also enables mechanical enforcement - the BetterAI plan-manifest gate
(BAI-702) captures the section from the plan file and denies Edit/Write calls
outside it, which only works when the section exists and is precise.

## When this applies

- Any plan, proposal, or design doc that precedes implementation.
- Any multi-file change; single-file bugfixes may state the one file inline.
- During implementation: before editing a file not in the manifest, either
  amend the plan or record a justification - never just edit.

## What good looks like

A precise, greppable section - one line per file, symbols named:

```markdown
## Files to touch
- app/retrieval/pipeline.py — query(), index_corpus()
- app/mcp/query_skills/handler.py — handle()
- tests/retrieval/unit/test_pipeline.py — new file
```

If an out-of-manifest edit turns out to be genuinely necessary mid-flight,
extend the manifest through the audited escape hatch instead of ignoring it -
a `justify:` line appended under the same section:

```markdown
- justify: app/errors.py — add Errors.query_error; discovered missing while
  wiring pipeline failures, cannot complete manifest scope without it
```

## Anti-patterns

Wrong - the vague touch set that permits anything:

```markdown
## Files to touch
- the retrieval layer
- tests as needed
```

Fixed: name each file path and the functions changing in it, as above. "As
needed" is exactly the creep the section exists to prevent.

Wrong - silently editing outside the manifest because "it's just a small
one-liner". The small one-liner is how every large unreviewed diff starts,
and under the BetterAI harness it is also a hard denial (BAI-702).

Fixed: add the `justify:` line first, then make the edit.

## Examples

Working under the BetterAI harness, the flow is: write the plan with
`## Files to touch` (the `write-scoped-plan` skill gives the exact grammar) -
the PostToolUse hook captures the manifest from the plan file - Edit/Write
inside the set proceed normally - an edit outside the set is denied with
BAI-702 and the denial message names the missing manifest entry - you either
amend the plan section or append a `justify:` line (audited, streamed as a
warning) and retry. Outside the harness the rule still applies; the reviewer
is the gate instead.
