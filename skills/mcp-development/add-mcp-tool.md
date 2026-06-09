---
id: add-mcp-tool
title: Add a new MCP tool to the betterai-server container
category: mcp-development
when_to_use: |
  When adding a new MCP tool to the betterai-server container — for example,
  a new `retrieve_*` variant scoped to a specific corpus slice, a new
  `record_*` tool for capturing agent feedback, or a maintenance tool for the
  rule index. Trigger signals: clients keep doing the same post-processing on
  a tool's output; a retrieval shape is general enough to deserve its own
  endpoint; you need a new audit event_type.
steps_count: 7
estimated_minutes: 30
applies_when:
  paths:
    - src/server/**
    - src/mcp-tools/**
  intents:
    - add mcp tool
    - new mcp tool
    - register tool
related_rules:
  - no-catch-all-exception-masking
related_skills:
  - write-vitest-fixture
created: 2026-06-09
---

## When to use this skill

Use this when a new MCP tool is genuinely warranted: it has a distinct input
schema, a distinct audit event_type, and a non-trivial implementation that
doesn't fit cleanly as a parameter on an existing tool. If you're adding a
boolean flag, that's not a new tool — that's a parameter.

Do NOT use this for ad-hoc one-off scripts. Those live in `scripts/` and
don't get MCP-exposed.

## Prerequisites

- Local dev loop working (`pnpm dev` runs `betterai-server` against the
  `rules/` directory in your worktree).
- An MCP client to test against (Claude Code, Cursor, or `mcp-cli`).
- Read access to `docs/MCP-TOOLS.md` so you can match existing tool style.
- Familiarity with the bearer-token middleware in
  `src/server/middleware/auth.ts` — your tool inherits it automatically.

## Steps

1. **Define the tool name + JSON schema for inputs.** Use snake_case for the
   tool name (e.g., `retrieve_by_intent`). The input schema is a Zod schema
   in `src/mcp-tools/<tool-name>/schema.ts`. Required fields go in
   `.strict()`; optional fields use `.optional()`. Document each field with
   `.describe(...)` — the description shows up in tool discovery.
2. **Register in `mcpServer.registerTool`** inside `src/server/registerTools.ts`.
   The registration block names the tool, attaches the schema, and points at
   the handler. Keep registrations alphabetically sorted so diffs stay
   reviewable.
3. **Implement the handler with bearer-token check inherited.** The handler
   lives at `src/mcp-tools/<tool-name>/handler.ts` and signs
   `(input, ctx) => Promise<Result>`. The auth middleware has already
   verified the bearer token before the handler runs — do not re-check.
   Throw typed errors (`new ToolError("...", { code: "..." })`) instead of
   catching and swallowing.
4. **Add an audit JSONL `event_type`.** Append a structured event to
   `audit/<yyyy-mm-dd>.jsonl` via the `audit.record(event_type, payload)`
   helper. Pick a stable name (e.g., `retrieve_by_intent.invoked`) and
   document it in `docs/AUDIT-EVENTS.md`.
5. **Write a Vitest integration test** at
   `src/mcp-tools/<tool-name>/handler.test.ts`. Cover the happy path, one
   schema-rejection path, and one error path. Assert audit JSONL contents
   (see the `write-vitest-fixture` skill).
6. **Update `docs/MCP-TOOLS.md`** with the new tool: name, purpose, input
   schema (rendered from Zod), example call, example response, and audit
   event_type. Out-of-date docs are a recurring failure here.
7. **Bump container minor version** in `Dockerfile` and `package.json`
   (`1.4.0 -> 1.5.0`). Adding a tool is additive but client tooling may want
   to gate on minimum versions, so a minor bump is the right semver move.

## What good looks like

A new MCP tool ships in under 30 minutes with full test coverage, audit
events, and docs. The handler is small and focused; the schema does most of
the validation work. Example shape:

```typescript
// src/mcp-tools/retrieve_by_intent/handler.ts
import { z } from "zod";
import { audit } from "../../server/audit";
import { ToolError } from "../../server/errors";

export const RetrieveByIntentInput = z
  .object({
    intent: z.string().min(1).describe("Free-form intent phrase"),
    limit: z.number().int().min(1).max(50).optional().default(10),
  })
  .strict();

export async function retrieveByIntent(input, ctx) {
  const hits = await ctx.index.searchByIntent(input.intent, input.limit);
  await audit.record("retrieve_by_intent.invoked", {
    intent: input.intent,
    hit_count: hits.length,
    client_id: ctx.clientId,
  });
  return { rules: hits };
}
```

## Common failure modes

- **Forgetting the audit event.** No JSONL line written → no way to debug
  why retrievals look weird two weeks later.
- **Catch-all try/catch in the handler** swallowing errors that should
  surface as MCP error responses. The middleware will translate
  `ToolError` correctly; just throw.
- **Schema with no `.describe()`.** Tool discovery returns nameless fields
  and clients can't self-document.
- **Skipping the docs update.** `docs/MCP-TOOLS.md` is the contract; if it's
  stale, downstream clients break.
- **Re-checking auth.** The middleware already did it; re-checking
  duplicates logic and risks divergence.
- **Bumping major version.** Adding a tool is additive; major bump signals a
  breaking change to clients and triggers their gate logic unnecessarily.

## Related rules

- `no-catch-all-exception-masking` — let typed errors propagate; don't
  swallow them in the handler.
