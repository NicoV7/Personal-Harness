---
id: docker-mcp-stdio-vs-http
title: MCP transport locked to HTTP/SSE — stdio fails across subagent boundary
date: 2026-06-09
project: betterai
kind: decision
context_keywords: [mcp, transport, stdio, http, sse, subagent, claude-code, workflow, bearer-token]
durability: long
auto_captured: false
applies_to_future_intents:
  - "configure MCP server transport"
  - "add stdio MCP for local agent"
  - "support new agent client"
  - "refactor MCP entrypoint"
related_rules: []
---

## What happened

The v4 design draft initially specified a hybrid transport: stdio for "local CLI agents" (Claude Code main loop, Cursor) plus HTTP/SSE for everything else. The stdio path looked attractive because no port, no auth token, lower setup friction.

The multi-agent eng review caught the failure. Stdio MCP connections live on the parent process's stdio pair — they do not propagate across the subagent boundary. Concretely: when Claude Code spawns a Task subagent, or when a Workflow `agent()` call boots a fresh model context, the child process has its own stdio and cannot see the parent's MCP stdio handshake. Every subagent retrieval would silently fall back to "no MCP tools available" without an error message.

Decision: v1 transport is HTTP/SSE only, on `127.0.0.1:7777`, gated by a bearer token written to `~/.betterai/token`. Every agent client — main loop, subagents, Workflow steps, Cursor, external scripts — connects the same way.

## Why it matters (for future me)

The whole point of BetterAI is that EVERY agent operation gets the corpus injected. A transport that works for the main loop but fails for subagents would mean rules apply only when the human is watching — exactly inverted from what we want, because subagents are where unsupervised code-writing happens.

The stdio bug is silent. There's no exception, no warning. The subagent just doesn't see the tools. Discovering this post-launch would mean weeks of "why aren't rules firing during /ship?" debugging before anyone connected it back to transport.

HTTP/SSE on localhost with a bearer token costs ~5 minutes of one-time setup (Docker `up`, copy token from logs). That's a cheap insurance policy against the silent-failure mode.

## Don't relitigate

Do NOT re-introduce stdio for retrieval tools. Do NOT add a "stdio mode" CLI flag for convenience. Do NOT propose stdio as a fast path for local-only setups.

The v1 transport is HTTP/SSE on `127.0.0.1:7777` with bearer-token auth, period. The only valid reopen: MCP gains a documented stdio-inheritance mechanism that covers the Claude Code Task tool AND Workflow `agent()` AND third-party clients. Until that exists, HTTP/SSE is the only correct choice.
