---
id: verify-uncertain-facts
title: Verify uncertain external facts via web search; resolve uncertain intent by asking — never guess
category: STANDARDS
domain: methodology
severity: high
created: 2026-06-10
applies_when:
  paths:
    - "**/*"
  intents:
    - "plan"
    - "design"
    - "research"
    - "upgrade"
    - "dependency"
    - "sdk"
    - "api"
    - "version"
    - "pricing"
    - "scope"
related:
  - config-from-env-not-hardcoded
check:
  kind: none
  notes: "Behavioral rule for agents; compliance is observable in the audit log as a web-search or clarifying-question step preceding decisions that cite external facts."
---

## What this rule says

When an agent is uncertain, the response depends on the *kind* of uncertainty:

1. **External facts** — SDK/API status, library versions, release dates, pricing, platform behavior, anything with a publication date: **verify with a web search before acting on it.** Training-data knowledge of fast-moving facts is stale by default.
2. **User intent or scope** — which track to pursue, how much to build, what trade-off the user prefers: **ask a direct question.** Do not pick silently, and do not bury the assumption in a paragraph.

Guessing is never the third option. An unverified fact that drives a design decision is a defect introduced at planning time, where it is cheapest to prevent and most expensive to discover.

## Why it matters

- **Stale-knowledge decisions compound.** A plan built on "the SDK transport API is still stabilizing" (true months ago, false now) defers the single most valuable item on the roadmap for no reason.
- **Silent scope guesses waste fleets.** Spawning parallel agents on the wrong track burns wall-clock and tokens that one clarifying question would have saved.
- **The audit log can prove compliance.** A retrieval/decision event preceded by a search or question step is verifiable; a guess is invisible until the diff is wrong. Agents are not monitored in real time — unverified assumptions have no human backstop.

## When this applies

**Applies:**
- Planning or design sessions that cite the state of an external dependency (SDK, API, model, platform).
- Any "should we X or Y" fork where the user's answer would change what gets built.
- Version bumps, migration decisions, anything quoting a price or limit.

**Skip:**
- Facts already verified this session (don't re-search what you just confirmed).
- Facts checkable locally and authoritatively (installed version in `node_modules`, lockfile, repo code) — local evidence beats search.
- Reversible micro-decisions with a conventional default (naming, formatting).

## What good looks like

```text
Handoff says: "MCP SDK HTTP transport was stabilizing — re-check the SDK now."
Agent: runs WebSearch("MCP TypeScript SDK StreamableHTTPServerTransport stable")
     → finds v1.29 ships it as the recommended transport
     → ALSO checks node_modules: installed version is already 1.29.0
     → plan wires the transport now instead of deferring it.

Agent unsure whether embeddings upgrade is in scope this cycle:
     → asks the user directly with the trade-off stated
     → user answers; plan reflects the answer, not a guess.
```

## Anti-patterns

```text
"The SDK transport API may still be unstable, so we'll keep the placeholder." (no search run)
"I assumed you wanted the reliability track only." (no question asked; user wanted embeddings too)
"Pricing is roughly $X per million tokens." (from memory, for a decision that depends on the number)
```

## Related

- `[[config-from-env-not-hardcoded]]` — same principle for values: facts live at their source of truth, not baked into artifacts that drift.
