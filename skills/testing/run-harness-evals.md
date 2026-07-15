---
id: run-harness-evals
title: Run BetterAI harness install smoke and task evals
category: testing
when_to_use: |
  Use when changing install.sh, Docker Compose, the stdio bridge, client
  adapters, hook/read-receipt enforcement, retrieval scoring, or task-eval
  fixtures. This is the release validation path for proving the harness both
  installs correctly and changes agent behavior.
steps_count: 6
estimated_minutes: 15
applies_when:
  paths:
    - install.sh
    - Dockerfile
    - app/cli.py
    - app/hooks/**
    - app/evals/**
    - tests/product/evals/**
  intents:
    - eval harness
    - install smoke
    - test installer
    - read receipts
    - client adapter
related_rules:
  - surgical-changes
related_skills:
  - implement-installable-harness-package
  - verify-always-consult-skills
  - write-vitest-fixture
created: 2026-06-17
---

## When to use this skill

Use this before releasing installer, adapter, retrieval, or hook changes. The
goal is two-part proof: the public install path wires up a real harness, and the
task-eval fixtures show BetterAI-specific guidance that a base model would not
know without retrieval.

## Steps

1. Run the fast local gate first:
   `pytest tests -m "not integration and not e2e"` and `bash -n install.sh`.
2. Run `betterai eval fixtures` (app/evals/rubric.py loads
   tests/product/evals/fixtures/*.yaml) and confirm the fixture you changed
   appears with expected rules/skills and rubric coverage.
3. For release smoke, run `betterai eval install-smoke` from a clean checkout.
   It uses a temporary `HOME`, a unique Compose container name, the generated
   stdio bridge, hook endpoints, and `get_skill` read receipts, and probes the
   full gate chain: read gate, retrieval-receipt gate (mutating tools denied
   until `query_skills` ran this turn, BAI-701), plan-manifest gate (BAI-702),
   and edit-budget gate (BAI-703).
4. If local Docker cost is too high during inner-loop work, run
   `betterai eval install-smoke --dry-run`; this checks scaffold, client
   adapters, generated hooks, permissions.allow auto-accept entries, file
   modes, and secret isolation without starting containers (implementation:
   app/evals/smoke.py).
5. Inspect the generated `report.json`. It must show no failed checks, no
   bearer/provider secret values in client configs, a blocked mutating tool
   before `get_skill`, a blocked final answer before `get_skill`, and an
   allowed ordinary tool after the read receipt. Client instruction artifacts
   must also preserve the clean-code pass for reducing nesting, extracting
   named helpers, clear naming, and composition.
6. Add or update a base-model-violating fixture whenever installer/client
   behavior changes. Avoid generic hygiene prompts that strong base models
   already pass without corpus help.

## What good looks like

`betterai eval install-smoke` leaves a redacted report with passing checks for
install, doctor, MCP bridge `tools/list`, `query_skills`, `get_skill`,
hook block/allow across all four gates, harness toggle, and secret scanning. The fixture set includes
at least one positive installer/client-adapter case and one negative no-match
case.
