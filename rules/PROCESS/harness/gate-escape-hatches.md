---
id: gate-escape-hatches
title: Diagnose BAI-700/701 gate denials; know the escape hatches
category: PROCESS
domain: harness
severity: high
created: 2026-07-15
applies_when:
  intents:
    - gate denial
    - BAI-700
    - BAI-701
    - read gate
    - retrieval receipt
    - hook debugging
related:
  - fail-loud-no-retries
---

## What this rule says

The prompt hook is the ONLY receipt writer the gates trust: it serves required skill bodies in `additionalContext` and marks both the retrieval receipt and the read receipts at delivery ("delivery IS the read event"). Receipts recorded by the MCP tools (`query_skills`, `get_skill`) land under the FastMCP transport session id — a different id space from the Claude Code hook session id — so they are advisory and can NEVER satisfy a hook-side gate. When serving fails, the hook releases gating for that turn (receipt without requirements) and surfaces the failure loudly as a warning line; a BAI-700/701 deny therefore always means the harness itself is broken, not that the agent skipped a step. The explicit deny-only escape hatches are `BETTERAI_READ_GATE=off` (BAI-700) and `BETTERAI_RECEIPT_GATE=off` (BAI-701); delivery, receipts, and audit keep running under both.

## Why it matters

An armed gate with no in-turn remedy is a deadlock, not a guardrail: before this contract, a retrieval warning left the turn required-but-unreceipted, every mutating tool was denied, and the suggested remedy ("call query_skills") could not work across the session-id boundary — agents burned whole turns retrying Writes that could never pass.

## When this applies

Whenever a PreToolUse deny cites BAI-700 or BAI-701, when hook warnings mention failed retrieval/serving, or when changing gate, receipt, or session-store code.

## What good looks like

On a deny: read the warning at the top of the turn's prompt context, run `betterai doctor` / fix the stack, then send a new message to start a fresh turn (the next delivery re-receipts). Only if the stack cannot be fixed right now, set the matching gate env to `off` — never both blindly, and turn it back on after.

## Anti-patterns

Retrying the denied Write unchanged; calling `query_skills`/`get_skill` to "earn" a hook receipt (advisory only); disabling the whole hook shim instead of the specific gate; treating a deny as agent misbehavior when the warning line already names the infra failure.
