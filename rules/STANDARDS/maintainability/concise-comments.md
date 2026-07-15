---
id: concise-comments
title: Comments explain WHY, never restate code — respect the configured budget
category: STANDARDS
domain: maintainability
severity: medium
forced: true
created: "2026-07-09"
when_to_use: Any time you write or edit code that could carry comments or docstrings.
applies_when:
  paths:
    - "**/*"
  intents:
    - comments
    - code comments
    - comment verbosity
    - docstring
    - documentation
    - readability
    - explain code
settings_schema:
  level:
    type: string
    pattern: "^(default|none|tokens:[1-9][0-9]*|lines:[1-9][0-9]*)$"
    description: >-
      Comment verbosity budget: default (model's own judgment), none (no new
      inline/block comments), tokens:<N> (max N tokens of new comment text per
      task), lines:<N> (max N comment lines per edited file). Set via
      configure_skill or `betterai configure concise-comments level=...`;
      overrides the BETTERAI_COMMENT_VERBOSITY env seed.
    default: default
settings:
  level: default
---

## What this rule says

Write the minimum number of comments that carry information the code cannot. A comment must state a constraint, invariant, or WHY that is invisible in the code itself — never narrate WHAT the next line does, restate a name, or describe the change you just made. When a `level` budget is configured (`none`, `tokens:<N>`, `lines:<N>`), the injected per-prompt policy line is a hard cap: stay under it or delete lower-value comments to make room. Docstrings on public functions and modules are documentation, not comments — they stay, but keep them to the contract (one summary line, args/returns/raises when non-obvious).

## Why it matters

Verbose comments rot: they drift from the code, double the review surface, and bury the one comment that actually matters (the load-bearing WHY) under narration nobody needs. A model that comments every block trains readers to skip all comments — which is worse than no comments at all.

## When this applies

Every code write or edit in any language. It does NOT apply to docstrings/API docs (governed by their own conventions), license headers, or directive comments the toolchain reads (`# type: ignore`, `# noqa`, `//go:generate`).

## What good looks like

```python
# redisvl validates the key with a live provider call at construction,
# which crash-looped boot during outages — construct lazily instead.
self._vectorizer = None
```

One comment, one non-obvious fact, placed where the decision is visible. Under `lines:2`, an edited file gains at most two such lines — the WHY survives, the narration never exists.

## Anti-patterns

```python
# create the client
client = OpenAI(base_url=base_url)  # OpenAI client pointed at OpenRouter
# now we call the model with the prompt
response = client.chat.completions.create(...)  # returns the response
```

Four comments, zero information. Also banned: changelog narration ("moved this from utils", "fixed per review"), commented-out code left "for reference", and restating a function's name above it.
