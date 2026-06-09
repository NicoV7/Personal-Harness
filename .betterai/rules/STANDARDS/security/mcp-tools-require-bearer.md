---
id: mcp-tools-require-bearer
title: Every MCP tool handler must verify the bearer token
category: STANDARDS
domain: security
severity: high
created: 2026-06-09
applies_when:
  paths: ["src/server/**", "src/mcp-tools/**", "src/middleware/**"]
  intents: ["add mcp tool", "implement handler", "review pr"]
---

## What this rule says

Every MCP tool handler in the BetterAI server MUST verify the `Authorization: Bearer <token>` header against the contents of `/data/token` before executing any work. The verification is enforced by a single middleware that is the default gate for all tools — individual handlers do not opt in, they would have to actively opt out, and opting out is forbidden except for the unauthenticated health-check endpoint.

The health-check endpoint may skip the bearer check, but every skip MUST emit an audit-log entry recording the bypass with the requester's IP and User-Agent. Silent bypasses are not allowed.

## Why it matters

Binding the server to `127.0.0.1` is not a substitute for authentication. The threat model already documents three concrete vectors that defeat localhost-only:

- **DNS rebinding** from a malicious page in any browser tab can post to `127.0.0.1:7777` after the page's hostname re-resolves.
- **Postinstall scripts** in untrusted npm packages run as the developer's UID and can reach the loopback interface.
- **Other dev tools** (background agents, CI runners, the developer's other AI clients) share the loopback namespace.

The corpus contains private decision memories, the audit log contains every prompt the developer has issued, and `check_file` (and any future file-reading tool) can read source from `/projects/`. A single un-gated tool is a full corpus + source-tree exfiltration vector. There is no "internal" tool that is safe to skip the check on — internal callers can present a bearer token just like external ones.

## When this applies

- Any PR that adds a new MCP tool handler under `src/mcp-tools/` or `src/server/handlers/`.
- Any PR that touches the HTTP/SSE transport registration in `src/server/main.ts`.
- Any PR that introduces a new middleware ordering — the bearer middleware MUST run before any tool dispatch.
- Any PR that adds a new endpoint outside the MCP envelope (e.g. a debug endpoint, a metrics scrape, a Prometheus exporter).

## What good looks like

A single middleware registered once, gating every tool by default. Health is the only allow-listed path, and it logs the bypass.

```ts
// src/server/middleware/require-bearer.ts
import type { Request, Response, NextFunction } from "express";
import { readFileSync } from "node:fs";

const TOKEN = readFileSync("/data/token", "utf8").trim();
const UNAUTHENTICATED_PATHS = new Set(["/health"]);

export function requireBearer(req: Request, res: Response, next: NextFunction) {
  if (UNAUTHENTICATED_PATHS.has(req.path)) {
    auditLog.info({
      event: "auth.bypass",
      path: req.path,
      ip: req.ip,
      ua: req.get("user-agent"),
    });
    return next();
  }
  const header = req.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || match[1] !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// src/server/main.ts
app.use(requireBearer); // BEFORE any tool route is registered
registerMcpTools(app);
```

## Anti-patterns

Wrong — a "trusted internal" tool that skips the check because it's "only called by the audit-replay subprocess":

```ts
// src/mcp-tools/replay-audit.ts
export function replayAudit(req: Request, res: Response) {
  // No bearer check — replay is local-only, called by audit-replay.ts
  const events = readAuditLog();
  return res.json({ events });
}
```

Wrong — per-handler bearer checks that one of them forgets:

```ts
export function retrieveContext(req, res) {
  if (!checkBearer(req)) return res.sendStatus(401);
  // ...
}
export function recordMemory(req, res) {
  // forgot the check — now a write endpoint with no auth
  writeMemory(req.body);
  return res.sendStatus(204);
}
```

Fixed: a single `app.use(requireBearer)` before any tool is registered, so forgetting is impossible by construction.

## Examples

```ts
// CORRECT: a new tool handler — no bearer logic at all, because the
// middleware handles it before the handler ever runs.
export function checkFile(req: Request, res: Response) {
  const { path } = req.body;
  const contents = readProjectFile(path);
  return res.json({ contents });
}
```
