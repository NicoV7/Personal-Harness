---
id: voluntary-retrieval-is-the-bottleneck
title: Voluntary retrieval is the load-bearing failure mode — auto-retrieve is Phase 1.0 Day 1
date: 2026-06-09
project: betterai
kind: discovery
context_keywords: [retrieval, auto-retrieve, tthw, subagent, voluntary, audit, phase-1, convergence]
durability: long
auto_captured: false
applies_to_future_intents:
  - "plan phase 1 milestones"
  - "scope MVP server"
  - "defer auto-retrieve to later phase"
  - "design retrieval UX"
related_rules: [search-context-before-substantive]
---

## What happened

Three independent eng reviews ran on 2026-06-09 — the corpus design review, the multi-agent evals review, and the DX review. They were briefed separately, used different evaluation rubrics, and reached the same headline finding: voluntary retrieval (where the agent decides whether to call `retrieve_rules`) is the single point of failure for the whole product.

The same root cause surfaced under three different names:

- Corpus review called it "TTHW blow-up" (time-to-first-helpful-write becomes unbounded when the agent skips the retrieval step).
- Multi-agent review called it "subagent propagation gap" (Task children inherit the tool registry but not the disposition to use it).
- DX review called it "did it work? debug confusion" (users can't tell whether rules fired, didn't fire, or fired and got ignored).

All three reviews independently recommended the same fix shape: a three-lever auto-retrieve stack (system-prompt prefix, server-side audit, optional skill file). See `auto-retrieve-three-levers` for the lever-by-lever decision.

## Why it matters (for future me)

Cross-review convergence is the strongest possible design signal. Three reviewers, three frames, three vocabularies, one root cause — that's not coincidence, that's the actual shape of the problem. Trust it.

The practical implication: auto-retrieve cannot be a Phase 1.5 polish item. If voluntary retrieval is broken, the entire MVP is broken — because the MVP's whole value proposition is "rules show up before code does." A server that exposes `retrieve_rules` and waits to be asked is not the product; it's an unused dependency.

Phase 1.0 Day 1 work is therefore not just "stand up the MCP server" but "stand up the MCP server WITH the auto-retrieve scaffolding." The CLAUDE.md prefix lever ships before the first real retrieval call.

## Don't relitigate

Do NOT defer auto-retrieve to Phase 1.5, Phase 2, or "after we see how it goes." Do NOT propose a "voluntary-first, force later" rollout — the failure mode is silent, so "see how it goes" means "ship a broken product and discover it from user complaints."

Auto-retrieve scaffolding (at minimum the system-prompt prefix and the server-side missed-retrieval audit) ships with the first server boot. If a future plan reopens this, the burden of proof is on the reopener to explain why three converged reviews were wrong.
