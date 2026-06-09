---
id: auto-retrieve-three-levers
title: Auto-retrieve uses three levers — no single mechanism is sufficient
date: 2026-06-09
project: betterai
kind: decision
context_keywords: [auto-retrieve, levers, system-prompt, audit, skill-file, claude-md, subagent, mcp]
durability: medium
auto_captured: false
applies_to_future_intents:
  - "design auto-retrieve mechanism"
  - "simplify retrieval enforcement"
  - "find one magic auto-retrieve solution"
  - "remove the CLAUDE.md prefix"
related_rules: [search-context-before-substantive]
related_memories: [voluntary-retrieval-is-the-bottleneck]
---

## What happened

Multi-agent eng review §1.6 explicitly searched for an MCP-native "always-call-this-tool-first" mechanism. There isn't one. The MCP protocol exposes tools but does not let a server demand it be called before other tools. So we evaluated three independent levers for forcing auto-retrieve:

- **Lever (a) — System-prompt prefix in CLAUDE.md.** Project-level CLAUDE.md gets a paragraph: "Before writing or planning code, call `retrieve_context` with the intent and any relevant paths." Loaded into every Claude Code main-loop and Task-spawned subagent.
- **Lever (b) — Server-side missed-retrieval audit.** The Docker MCP server logs every tool call. A periodic job flags sessions that wrote code (detected by `Write`/`Edit` audit rows) without a preceding `retrieve_*` call in the same session window. Surfaces as a daily report.
- **Lever (c) — Optional `~/.claude/skills/betterai-auto-retrieve/SKILL.md`.** A user-installed skill profile that names the retrieve step explicitly in its trigger description, so the skill router invokes it.

Decision: belt-and-suspenders. (a) is mandatory, (b) is recommended for v1, (c) is optional opt-in for users who want extra coverage.

## Why it matters (for future me)

Each lever covers a different failure class:

- (a) covers the main loop + Claude-spawned Task subagents (they inherit CLAUDE.md), but does NOT cover Workflow `agent()` calls that pass a custom system prompt, and does NOT cover non-Claude clients (Cursor, custom scripts).
- (b) detects misses post-hoc regardless of client. It's the audit safety net — even if (a) and (c) both fail, the missed-retrieval report eventually surfaces the gap. But (b) is reactive, not preventive.
- (c) helps when the user's skill profile loads but the main system prompt is overridden (some Workflow setups, some IDE extensions). It's the only lever that can attach to a skill router rather than a system prompt.

The honest summary: there is no single magic mechanism. Anyone who proposes "just do (a)" or "just do (b)" is wrong, and the documented failure modes prove it.

## Don't relitigate

Do NOT pursue a single "one true" auto-retrieve mechanism. Do NOT delete the CLAUDE.md prefix because "the audit catches misses anyway" — the audit is reactive, the prefix is preventive, you want both.

If MCP itself gains a `requires_first_call` capability (or equivalent), that's a valid reopen. Until then, the three-lever stack is the answer. Document each lever's coverage in the user-facing setup guide so users understand which gaps they're patching when they enable lever (c).
