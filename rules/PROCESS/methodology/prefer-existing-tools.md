---
id: prefer-existing-tools
title: Search for an existing tool before building a new component
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
    - new component
    - build from scratch
related:
  - plans-enumerate-touch-set
  - simplicity-first
---

## What this rule says

Before building any non-trivial new component (a memory store, an embedding
pipeline, a config loader, a queue, a scheduler), run a real search for an
existing tool that already does the job: GitHub, Hugging Face, npm, PyPI,
using the agent's own web tools. The plan that proposes the component must
cite the search - what was searched, the top candidates considered, and the
verdict (adopt X / build because Y). "Build" is a valid verdict, but it must
be an argued conclusion, not the unexamined starting point.

## Why it matters

Agents default to writing code because writing code is what they are best at.
The result is a fleet of homegrown half-implementations of solved problems:
worse than the OSS equivalent, unmaintained, and untested against the edge
cases the OSS project spent years finding. Ten minutes of searching routinely
saves days of building plus the permanent carrying cost of owning the code.
The citation requirement exists because an uncited "we looked, nothing fits"
is indistinguishable from "we did not look".

## When this applies

- Any plan or proposal that introduces a new module with a well-known problem
  shape (storage, retrieval, auth, scheduling, parsing, migration).
- Any "let's write a small X" where X has an ecosystem (a YAML parser, an
  HTTP client wrapper, a vector index).
- Does NOT apply to glue code, project-specific business logic, or components
  whose whole point is to encode this project's private conventions.

## What good looks like

A plan section that shows the search happened and what it concluded:

```markdown
## Existing-tools search
- Searched: GitHub "markdown memory MCP server", PyPI "frontmatter knowledge base"
- Candidates: basic-memory (md+frontmatter native, first-party MCP, AGPL ok
  for local), cognee (heavier, graph-focused)
- Verdict: ADOPT basic-memory; cognee documented as fallback. No build.
```

And the inverse - a justified build:

```markdown
## Existing-tools search
- Searched: GitHub/PyPI "hybrid BM25 vector rerank pipeline redis"
- Candidates: haystack, llamaindex retrievers
- Verdict: BUILD - no candidate combines redisvl HybridQuery, write-through
  PG, and our progress-streaming contract; adopting would mean wrapping 80%
  of it anyway.
```

## Anti-patterns

Wrong: the plan opens with "We will implement a memory store in
`app/memory/store.py`" - no search section, no candidates, no verdict. The
component ships, and three weeks later someone finds the OSS project that
does the same thing with migrations, tests, and an MCP server already built.

Fixed: the plan carries an "Existing-tools search" block (as above) before any
new-component section, and the reviewer can check the verdict rather than
re-run the search themselves.

## Examples

Quick litmus test while planning: for each new module in the touch set, ask
"does this problem have a name?" If it has a name (embeddings cache, cron
runner, TOML config), it has an ecosystem, and the plan needs a cited search
before proposing to build it. If it only has a description ("the thing that
maps our gate denials to our audit rows"), it is glue and you can just build
it.
