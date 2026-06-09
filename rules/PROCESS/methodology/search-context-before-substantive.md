---
id: search-context-before-substantive
title: Search the corpus, session memory, and the web before substantive work
category: PROCESS
domain: methodology
severity: high
created: 2026-06-09
applies_when:
  intents: [plan, investigate, debug]
related: [think-before-coding, checkpoint-context-around-compaction]
source: RULES.md rule 1
---

## What this rule says

Before doing substantive work, search three places for prior context: the BetterAI rule/skill/memory corpus, the current session's accumulated context (decisions already made, files already read, errors already seen), and the public web. "Substantive" is precise here: it means **proposing an architecture, debugging code, recommending tools or libraries, or writing more than ten lines of code**. Trivial edits — fixing a typo, renaming a single symbol the user pointed at — do not require a search round.

The three sources answer three different questions. The corpus answers "is there a constraint or pattern I should know about?" Session memory answers "have I already decided this in the last hour?" The web answers "is there a current-as-of-today fact I can't infer from the model weights?" Skipping any of the three produces a predictable failure mode: skipping the corpus means restating a constraint as a fresh discovery; skipping session memory means contradicting a decision you yourself just made; skipping the web means citing an API or version that changed.

## Why it matters

The agent's model weights have a knowledge cutoff and were never trained on this project's history. Without a search round, every substantive proposal is being made from a partial picture: the agent is guessing at what the project already decided, what tools have already been rejected, and what the world looked like when the data was frozen. Each of those guesses has a real failure mode in production: recommending a library the team already vetoed, "fixing" a bug that's actually a deliberate design choice, citing a tutorial that no longer reflects the API.

Searching first is the cheapest defensive move in the entire workflow. A corpus query costs milliseconds; a web fetch costs seconds; the cost of a bad architectural recommendation that gets implemented is hours-to-days. The asymmetry is overwhelming.

## When this applies

- Planning: you are about to outline how to implement a feature, before any code is written.
- Investigating: the user reports a behavior and you are about to form a hypothesis about its cause.
- Debugging: you are about to propose a fix for a failing test, error log, or user-reported bug.
- Tool recommendations: you are about to suggest a library, framework, or third-party service.
- Non-trivial code authoring: your edit will exceed ~10 lines of new logic.

It does NOT apply to: typo fixes, renames the user explicitly directed, deleting a single file the user pointed at, or answering a factual question that has nothing to do with this codebase ("what's the syntax for a TypeScript generic?").

## What good looks like

A search round before substantive work has three parallel queries — corpus, session memory, web — and a one-paragraph summary of what they returned before any proposal. The summary names the intent, names what was found, and names what wasn't found so the agent's reasoning is auditable.

```typescript
// Before proposing rate-limiting architecture, search first.
const corpusHits = await retrieve_rules({
  intent: "implement rate limiting",
  paths: ["src/api/**"],
});
const memoryHits = await retrieve_memories({
  context_keywords: ["rate-limit", "redis", "api"],
});
const webHits = await webSearch(
  "Express rate limit middleware 2026 best practices",
);

// Then summarize:
// "Corpus: no existing rate-limit rule; nearest is no-god-files (irrelevant).
//  Memory: 2025-11 we rejected token-bucket-redis due to ops cost; chose in-memory.
//  Web: express-rate-limit v7 is current; uses ip-keyv abstraction.
//  Proposal: in-memory sliding window per the 2025-11 decision; reconsider redis only if multi-instance."
```

## Anti-patterns

**Wrong:** Skipping the search and proposing directly from model weights.

```typescript
// User: "Add rate limiting to the API"
// Agent immediately: "I'll add express-rate-limit with a Redis backend..."
// Problem: the 2025-11 memory said "no redis." Agent has now proposed
// a solution already rejected by the team, and the user has to relitigate it.
```

**Fixed:** Search first, propose second, cite what was found.

```typescript
// Agent: "Searching corpus and memory first…
// Found a memory from 2025-11 rejecting redis-backed rate limiting due to ops cost.
// Recommending in-memory sliding window unless something has changed since then.
// Proceed?"
```

The fixed version costs one extra retrieval round and saves the team from re-arguing a decision.

## Examples

A web-fetch round is part of "search" even when the topic feels stable. APIs version, deprecate, and rename on a faster cycle than model weights update. If the proposal touches a third-party SDK, the web round is mandatory; if it touches a standard-library feature the model has known for years, the web round is optional but cheap.

A common shortcut to resist: "I already searched at the start of this session, so I don't need to search again." The corpus and memory change as the session itself adds new entries. Re-search at each substantive decision point, not once per session.
