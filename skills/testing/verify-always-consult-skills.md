---
id: verify-always-consult-skills
title: Verify BetterAI skills are consulted on every prompt
category: testing
when_to_use: |
  Use when changing prompt hooks, read receipts, client adapters, MCP
  instructions, or install smoke behavior that controls whether agents retrieve
  and read BetterAI skills on every prompt.
steps_count: 7
estimated_minutes: 10
applies_when:
  paths:
    - app/hooks/**
    - app/mcp/*_gate/**
    - app/installer/adapters.py
    - app/evals/**
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
3. Confirm the prompt hook SERVES required skill bodies inline (forced-first,
   capped by BETTERAI_REQUIRED_READS_MAX) and marks read receipts at delivery.
4. Confirm `PreToolUse` blocks only MUTATING tools (Edit/Write/MultiEdit/
   NotebookEdit) while required skills are unread; read-only tools, ToolSearch,
   and subagent spawns always pass (deadlock post-mortem 2026-07-15), and
   BETTERAI_READ_GATE=off disables only the deny.
5. Confirm the retrieval-receipt gate denies mutating tools when `query_skills`
   has not run this turn (BAI-701), and that the companion gates in the same
   chain keep their contracts: plan-manifest denies out-of-manifest Edit/Write
   (BAI-702) and edit-budget denies over-budget mutations (BAI-703).
5. Confirm `Stop` blocks once when required skills remain unread, then avoids an
   infinite loop on repeated stop attempts; in active edit-budget modes the
   Stop hook never blocks, because stopping to converse is the point.
6. Confirm the Claude adapter's auto-allowed permissions
   (`permissions.allow` entries for `query_skills`/`get_skill`/
   `list_skills`) cover ONLY read-only tools — auto-accept removes the
   permission prompt, never the gates; mutating tools stay prompted and
   gated.
7. Run the focused hook/adapter/eval tests and the full install smoke when
   changing installer or client integration behavior.

## What good looks like

A matched skill produces a read receipt before the agent can continue, and the
turn's retrieval receipt exists before any mutating tool runs. A no-match
prompt proceeds without friction. Codex and generic clients receive the same
contract through MCP instructions and managed instruction files, even though
only Claude has deterministic hook blocking.
