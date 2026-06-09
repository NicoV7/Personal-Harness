---
id: audit-must-include-parent-session
title: Subagent audit events must set parent_agent_session_id
category: STANDARDS
domain: observability
severity: high
created: 2026-06-09
applies_when:
  paths: ["src/audit/**", "src/server/handlers/**"]
  intents: ["implement audit", "emit event", "review pr"]
---

## What this rule says

Audit events emitted from a subagent context (any event whose `subagent_class` is not `"main"`) MUST populate `parent_agent_session_id` from the MCP request metadata. A missing or null `parent_agent_session_id` on a subagent event is a bug, not an optional field — the schema validator rejects the event at emit time and the server logs an error.

The `main` agent class is the only class that may emit events with a null `parent_agent_session_id`. Every other class — `planner`, `reviewer`, `coder`, `tester`, and any future subagent class — MUST carry the parent.

## Why it matters

Per the multi-agent eng review §1.4, `parent_agent_session_id` is the join key that powers two of the corpus's highest-value analyses:

- **Per-workflow rule-effectiveness measurement.** Without the parent id we cannot ask "did this rule, when fired in a subagent, change the outcome of the parent workflow?"
- **Audit-replay correlation.** Replaying a parent session needs to recursively reconstruct the subagent calls it triggered; with a null parent the replay sees orphan events and silently drops them.

A null value here doesn't crash anything. It silently breaks the analyzer downstream, weeks or months later, when the data is gone. The cost is invisible by design — which is exactly why the schema must enforce it at emit time.

## When this applies

- Any code path that calls `auditLog.emit(...)` or the equivalent `recordAudit(...)` helper.
- Any new tool handler under `src/server/handlers/` that fans out to a subagent via the workflow runtime.
- Any new subagent class registered in `src/audit/subagent-classes.ts`.
- Any PR that changes the audit-event schema.

## What good looks like

The audit-emit helper validates the event before serializing it. The validator is the single chokepoint — no caller can bypass it.

```ts
// src/audit/emit.ts
import type { AuditEvent } from "./types.js";

export function emitAudit(event: AuditEvent): void {
  if (event.subagent_class !== "main" && !event.parent_agent_session_id) {
    logger.error(
      { event_id: event.id, subagent_class: event.subagent_class },
      "audit.emit.invalid: subagent event missing parent_agent_session_id",
    );
    throw new AuditValidationError(
      "subagent audit event must set parent_agent_session_id",
    );
  }
  auditSink.write(JSON.stringify(event) + "\n");
}
```

A subagent handler that correctly threads the parent through the request:

```ts
// src/server/handlers/retrieve-context.ts
export function retrieveContext(req: Request, res: Response) {
  const meta = parseMcpMetadata(req);
  emitAudit({
    id: ulid(),
    ts: new Date().toISOString(),
    event: "retrieve_context.invoked",
    subagent_class: meta.subagent_class,
    parent_agent_session_id: meta.parent_session_id, // never null for subagents
    // ...
  });
}
```

## Anti-patterns

Wrong — emit an event with `subagent_class` set but `parent_agent_session_id` left null because "we couldn't find the parent in the headers":

```ts
emitAudit({
  id: ulid(),
  event: "retrieve_context.invoked",
  subagent_class: "planner",
  parent_agent_session_id: null, // "we'll figure it out later"
});
```

Wrong — defaulting silently to `"main"` when the metadata is missing, which is worse than the null because it lies:

```ts
const klass = meta.subagent_class ?? "main"; // hides the bug from the validator
emitAudit({ ..., subagent_class: klass, parent_agent_session_id: null });
```

Fixed: the validator throws at emit time and the request returns a 500 with a clear error. Surface the bug loudly — silent drops cost more than a noisy crash.

## Examples

```ts
// CORRECT: when the handler genuinely is the top-level agent, the class
// is "main" and parent_agent_session_id is legitimately null. The
// validator allows this because the class agrees with the absence.
emitAudit({
  id: ulid(),
  ts: new Date().toISOString(),
  event: "user_prompt.received",
  subagent_class: "main",
  parent_agent_session_id: null,
  prompt_hash: sha256(prompt),
});
```
