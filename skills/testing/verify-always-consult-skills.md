---
id: verify-always-consult-skills
title: Verify BetterAI skills are consulted on every prompt
category: testing
when_to_use: |
  Use when changing prompt hooks, read receipts, client adapters, MCP
  instructions, or install smoke behavior that controls whether agents retrieve
  and read BetterAI skills on every prompt.
steps_count: 6
estimated_minutes: 10
applies_when:
  paths:
    - src/hooks/**
    - src/runtime/read-receipts.ts
    - src/cli/adapters.ts
    - src/cli/eval.ts
    - install.sh
  intents:
    - always consult skills
    - read skill every prompt
    - prompt hook
    - stop hook
    - read receipts
related_skills:
  - run-harness-evals
  - implement-installable-harness-package
created: 2026-06-17
---

## When to use this skill

Use this for any change that could let an agent answer, plan, or use ordinary
tools before loading the matched BetterAI skills for the current prompt.

## Steps

1. Confirm `UserPromptSubmit` runs retrieval server-side (which marks the
   retrieval receipt for the turn) and resets read receipts for the current
   session turn.
2. Confirm the hook injects context that tells the agent to call `get_skill`
   for every matched skill before planning, answering, or ordinary tool use.
3. Confirm `PreToolUse` blocks ordinary tools while required skills are unread
   but still allows BetterAI bootstrap tools such as `query_skills` and
   `get_skill`.
4. Confirm the retrieval-receipt gate denies mutating tools when `query_skills`
   has not run this turn (BAI-701), and that the companion gates in the same
   chain keep their contracts: plan-manifest denies out-of-manifest Edit/Write
   (BAI-702) and edit-budget denies over-budget mutations (BAI-703).
5. Confirm `Stop` blocks once when required skills remain unread, then avoids an
   infinite loop on repeated stop attempts; in active edit-budget modes the
   Stop hook never blocks, because stopping to converse is the point.
6. Run the focused hook/adapter/eval tests and the full install smoke when
   changing installer or client integration behavior.

## What good looks like

A matched skill produces a read receipt before the agent can continue, and the
turn's retrieval receipt exists before any mutating tool runs. A no-match
prompt proceeds without friction. Codex and generic clients receive the same
contract through MCP instructions and managed instruction files, even though
only Claude has deterministic hook blocking.
