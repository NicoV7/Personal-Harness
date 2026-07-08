---
id: write-scoped-plan
title: Write a scoped plan with an enforceable Files to touch manifest
category: planning
forced: true
when_to_use: |
  Whenever you are about to plan, design, propose, or architect a change of
  any size under the BetterAI harness. This skill is forced: it is injected
  on planning intents regardless of retrieval score, because the plan you
  write becomes the enforcement manifest for the implementation that follows.
steps_count: 6
estimated_minutes: 10
applies_when:
  intents:
    - plan
    - design
    - propose
    - architecture
related_rules:
  - plans-enumerate-touch-set
  - prefer-existing-tools
related_skills:
  - edit-incrementally
created: 2026-07-06
---

## When to use this skill

Use this before writing any implementation plan. The BetterAI harness treats
the plan file as machine-readable: a PostToolUse hook parses its
`## Files to touch` section into a manifest, and the plan-manifest gate then
denies any Edit/Write outside that manifest (BAI-702). A plan without the
section, or with a sloppy one, either leaves the gate inactive or blocks your
own implementation - so the section's grammar matters.

## Prerequisites

- You know the goal well enough to name the files it will change; if not,
  investigate first - a plan is not a place for "TBD".
- Web/search tools available for the existing-tools check.

## Steps

1. **Run and cite an existing-tools search.** For every non-trivial new
   component the plan introduces, search GitHub/Hugging Face/npm/PyPI with
   your own web tools and record an "Existing-tools search" block: what you
   searched, the candidates, and the verdict (adopt X / build because Y). See
   the `prefer-existing-tools` rule; an uncited "nothing fits" does not count.
2. **Enumerate the touch set.** Add a `## Files to touch` section listing
   every file the implementation will create or modify, one bullet per file
   in the exact grammar `- path — functions` (repo-relative path, an em dash,
   then the functions/symbols affected or "new file"). Example:
   `- app/retrieval/pipeline.py — query(), index_corpus()`.
3. **Keep the grammar strict.** One file per line, no globs, no prose bullets
   like "tests as needed". The parser is a strict section grammar; a
   malformed section is a parse failure, which logs a warning and leaves the
   gate INACTIVE - your plan then enforces nothing.
4. **Write the rest of the plan** (approach, risks, validation) as usual;
   only the manifest section is machine-read.
5. **Understand the gate you just armed.** After the plan file is written,
   the hook captures the manifest. During implementation, an Edit/Write to a
   file not in the manifest is denied with BAI-702; edits to the plan file
   itself are always allowed.
6. **Know the escape hatch.** If implementation genuinely needs a file the
   plan missed, append a `justify:` line to the `## Files to touch` section
   before retrying the edit: `- justify: <path> — <reason it is required>`.
   The extension is allowed, audited, and streamed back as a warning - it is
   for discoveries, not for skipping planning.

## What good looks like

A plan whose `## Files to touch` reads like a diffstat prediction:

```markdown
## Files to touch
- app/mcp/query_skills/handler.py — handle()
- app/retrieval/pipeline.py — query(), new progress events
- tests/retrieval/unit/test_pipeline.py — new file
```

Implementation then proceeds without a single BAI-702 denial, or with one
deliberate, well-reasoned `justify:` extension that a reviewer can audit.

## Common failure modes

- **Vague bullets** ("the retrieval layer", "tests as needed") - either the
  parser rejects the section (gate inactive) or the manifest blocks the real
  files you meant.
- **Skipping the existing-tools citation** - the plan proposes building a
  component the ecosystem already ships; reviewers bounce it.
- **Treating `justify:` as a bypass** - every extension is audited and
  warned; several in one run means the plan was fiction and should be redone.
- **Forgetting new files** - creation is a Write and is gated too; list new
  files with "new file" as the functions note.

## Related rules

- `plans-enumerate-touch-set` - the constraint this skill operationalizes.
- `prefer-existing-tools` - the search the plan must cite.
