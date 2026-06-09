---
id: no-stdio-mcp-transport
title: Never add a stdio MCP transport to the betterai-server
category: STANDARDS
domain: maintainability
severity: high
created: 2026-06-09
applies_when:
  paths: ["src/server/main.ts", "src/server/transport/**"]
  intents: ["add transport", "review pr", "modify server entry"]
---

## What this rule says

The `betterai-server` MUST expose MCP exclusively over HTTP/SSE bound to `127.0.0.1:7777`, gated by a bearer token. A stdio MCP transport MUST NOT be registered, even as an opt-in flag, even "just for the local CLI", even "behind an env var." The `bin/betterai` CLI shim uses `docker exec` for non-MCP operations; MCP calls are HTTP regardless of which client is calling.

The server's `main.ts` should have exactly one transport registration: `registerHttpSseTransport(...)`. PRs that add `registerStdioTransport(...)` — or any moral equivalent like `new StdioServerTransport()` — are rejected.

## Why it matters

Stdio MCP transports do not propagate. When a Claude Code main agent has BetterAI registered over stdio, and that main agent spawns a subagent (via the `Task` tool, the Workflow runtime, or any equivalent), the subagent does NOT inherit the parent's stdio pipe. The subagent opens its own MCP connection, and if BetterAI is only on stdio, the subagent silently has no BetterAI tools at all.

This is the failure mode that undermines the entire multi-agent design:

- The orchestrator agent gets BetterAI rules. Its subagents (planner, reviewer, coder) get nothing.
- The audit log shows the orchestrator querying retrieval, but no subagent events. The analyzer concludes "subagents don't use BetterAI" — wrong, they can't reach it.
- The fix two weeks later requires migrating to HTTP anyway, plus a postmortem on every subagent decision made without the corpus.

The full decision rationale lives in `memories/2026-06/docker-mcp-stdio-vs-http.md`. The short version: HTTP is the only transport that propagates across process boundaries within the Claude Code agent tree, so HTTP is the only transport BetterAI ships.

## When this applies

- Any PR that touches `src/server/main.ts`.
- Any PR that adds a new file under `src/server/transport/`.
- Any PR that vendors or upgrades the `@modelcontextprotocol/sdk` dependency, since new SDK versions sometimes add stdio helpers that are tempting to wire up.
- Any proposal in design docs, RFCs, or PR descriptions that mentions "stdio" in the context of the server.

## What good looks like

The server's entrypoint registers exactly one transport, with the bearer middleware in front of it.

```ts
// src/server/main.ts
import express from "express";
import { registerHttpSseTransport } from "./transport/http-sse.js";
import { requireBearer } from "./middleware/require-bearer.js";
import { registerMcpTools } from "./mcp-tools/index.js";

const app = express();
app.use(express.json());
app.use(requireBearer);

registerMcpTools(app);
registerHttpSseTransport(app); // the only transport. do not add another.

app.listen(7777, "127.0.0.1");
```

A CLI shim that uses HTTP for MCP and `docker exec` for ops:

```ts
// bin/betterai (TypeScript source)
async function callMcp(tool: string, args: unknown) {
  const token = readFileSync(`${HOME}/.betterai/token`, "utf8").trim();
  return fetch("http://127.0.0.1:7777/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
  });
}

async function execDockerOp(verb: string, args: string[]) {
  return spawn("docker", ["exec", "betterai", "betterai-server", verb, ...args]);
}
```

## Anti-patterns

Wrong — adding a stdio transport "for the local CLI because it's simpler":

```ts
// src/server/main.ts
registerHttpSseTransport(app);
registerStdioTransport(process.stdin, process.stdout); // DO NOT
```

Two weeks later: `claude --agent reviewer` runs, the reviewer subagent has no rules, and a regression ships that the corpus would have caught.

Wrong — gating stdio behind an env var "for development only":

```ts
if (process.env.BETTERAI_ENABLE_STDIO === "1") {
  registerStdioTransport(process.stdin, process.stdout);
}
```

The env var gets set in a `.envrc` somewhere, the developer forgets, and the failure mode is identical to the unconditional case but harder to find.

Fixed: there is no stdio path. The CLI uses HTTP. The MCP client config in Claude Code uses HTTP. Subagents inherit HTTP.

## Examples

```ts
// CORRECT: the only place a transport is registered. One call. No flags.
// No alternatives. Future-you reading this in six months: do not add a
// second one. Read memories/2026-06/docker-mcp-stdio-vs-http.md first.
import { registerHttpSseTransport } from "./transport/http-sse.js";
registerHttpSseTransport(app);
```
