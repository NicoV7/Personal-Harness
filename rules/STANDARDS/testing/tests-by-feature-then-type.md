---
id: tests-by-feature-then-type
title: Organize tests by feature first, then by test type
category: STANDARDS
domain: testing
severity: medium
created: 2026-07-06
applies_when:
  paths: ["tests/**", "**/*.test.*"]
  intents:
    - write test
    - add test
    - test layout
    - scaffold
    - new module
related:
  - no-emojis-in-tests
  - no-god-files
---

## What this rule says

The test tree is organized feature-first, then by test type:
`tests/<feature>/{unit,integration,e2e,evals}/`. The top level names the
product features/modules (`retrieval`, `corpus`, `installer`, `hooks`);
inside each feature, subdirectories split by how the tests run. Never
type-first (`tests/unit/**` spanning every feature) and never a flat
directory of mixed test files.

## Why it matters

Tests are read and run along feature lines: when you change retrieval, you
want every retrieval test - unit through eval - in one place, runnable with
one path argument (`pytest tests/retrieval`). Type-first layouts scatter one
feature's tests across four distant directories, so coverage gaps hide (the
feature has unit tests here, but did anyone write the integration ones over
there?) and feature-scoped runs require fragile `-k` name filters. Flat
layouts are worse: no way to run "just the fast tests for this module", and
the directory becomes a god-file at the filesystem level. The type split
within a feature still matters because it encodes runtime cost - unit tests
run everywhere, integration needs containers, e2e needs a live server - and
CI selects by that axis (`pytest -m "not integration" tests/retrieval`).

## When this applies

- Creating any new test file: place it under its feature, then its type.
- Scaffolding a new module: create `tests/<feature>/unit/` alongside it.
- Reviewing a PR that adds `tests/unit/`, `tests/integration/` at the top
  level, or drops test files directly in `tests/` - flag it.

## What good looks like

```text
tests/
  retrieval/
    unit/            test_hybrid.py, test_rerank.py
    integration/     test_indexer_write_through.py   (@pytest.mark.integration)
    e2e/             test_staged_streaming.py        (@pytest.mark.e2e)
    evals/fixtures/  provider-down-fail-hard.yaml
  corpus/
    unit/            test_schema.py
    integration/     test_reader_scope_merge.py
  installer/
    unit/  integration/  e2e/
```

Feature-scoped runs fall out for free: `pytest tests/retrieval` runs
everything about retrieval; `pytest tests/retrieval/unit` is the sub-second
inner loop.

## Anti-patterns

Wrong - type-first, features smeared across the tree:

```text
tests/
  unit/         test_hybrid.py, test_schema.py, test_adapters.py
  integration/  test_indexer.py, test_reader.py
  e2e/          test_everything.py
```

Wrong - flat: forty `test_*.py` files directly under `tests/`, no way to run
one feature or one cost tier.

Fixed: move each file under `tests/<feature>/<type>/`; the filename no longer
has to carry the feature name for you to find it.

## Examples

Deciding placement for a new test: first ask "which feature does this
exercise?" (the module whose behavior the assertion is about - not where the
helper lives), then "what does it need to run?" (nothing -> `unit/`, live
containers -> `integration/`, a running server plus a real client -> `e2e/`,
an LLM-judged fixture -> `evals/`). If a test seems to belong to two
features, it is testing the seam - put it under the feature that owns the
behavior being asserted, and cross-reference from the other only if truly
necessary.
