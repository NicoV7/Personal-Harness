---
id: three-artifact-kinds-decided
title: Corpus locked to three artifact kinds — rules, skills, memories
date: 2026-06-09
project: betterai
kind: decision
context_keywords: [rules, skills, memories, corpus, schema, three-kinds, conflict-resolution, retrieve-context]
durability: long
auto_captured: false
applies_to_future_intents:
  - "add new artifact kind"
  - "collapse skills into rules"
  - "redesign corpus schema"
  - "add examples directory"
related_rules: []
related_memories: [voluntary-retrieval-is-the-bottleneck]
---

## What happened

The multi-agent eng review on 2026-06-09 forced the corpus structure question to a decision. The locked answer: BetterAI's corpus contains exactly three sibling artifact kinds.

- **Rules** are constraints — "DON'T do X" / "DO Y when Z." Categories: STANDARDS, PROCESS, PATTERNS, ARCHITECTURE, DOCUMENTATION.
- **Skills** are procedures — "HOW to accomplish Y, step by step."
- **Memories** are episodes — "LAST time we tried Z, here's what happened."

All three live under one corpus root, are indexed by the same retrieval pipeline, and are returned by the `retrieve_context` aggregator tool (which fans out and merges results from `retrieve_rules`, `retrieve_skills`, `retrieve_memories`).

Conflict resolution priority (per multi-agent review §2.1 #12): `memory.kind=decision AND durability=long` > `rule` > `skill`. A long-lived decision memory beats a rule because the memory is the WHY the rule exists; a rule beats a skill because constraints bound procedures.

## Why it matters (for future me)

The temptation is always to start with one kind ("everything is a rule") and bolt others on later. That temptation is a trap for two reasons:

1. The MCP tool surface would have to be refactored — adding `retrieve_skills` and `retrieve_memories` later means existing agent prompts referencing `retrieve_rules` need updating, and the aggregator tool has to be designed retroactively.
2. The audit schema (which records every retrieval for the missed-retrieval signal) would need migration — adding `kind` to existing rows breaks the analytics queries that assumed a single artifact type.

Catching this at design time cost ~6 lines of audit schema extension (`kind TEXT NOT NULL`) and one aggregator tool design. Catching it post-launch would have been a v2 schema migration plus a tool-surface deprecation cycle.

## Don't relitigate

Do NOT collapse the three kinds into one. Do NOT propose "everything is a rule, skills are just rules tagged procedural" — the three kinds have genuinely different shapes (rules have severity, skills have steps_count, memories have durability) and different conflict-resolution behavior.

Do NOT add a fourth kind without re-opening the whole schema. Specifically:

- "Examples" is not a fourth kind — examples live inside rule bodies (## Examples section). The corpus eng review §2.1 #8 already covered this.
- "Patterns" is not a fourth kind — PATTERNS is a category WITHIN rules.
- "Templates" is not a fourth kind — templates are fix_templates inside rule frontmatter.

If a future need genuinely cannot fit into rules/skills/memories, the burden of proof is high: show that all three existing shapes were tried and failed.
