---
id: typed-errors-from-errors-layer
title: Throw typed errors from a central errors/ layer; never `new Error("string")` at call sites
category: STANDARDS
domain: error-handling
severity: high
created: 2026-06-09
applies_when:
  paths:
    - "src/**/*.ts"
    - "src/**/*.tsx"
  intents:
    - "auth"
    - "transport"
    - "validation"
    - "boot"
    - "io"
    - "fs"
  patterns:
    - "throw new Error\\("
    - "c\\.json\\(\\s*\\{\\s*error:\\s*\""
related:
  - layered-architecture-default
  - no-catch-all-exception-masking
check:
  kind: regex
  pattern: "throw new Error\\(\""
  notes: "Flags ad-hoc `throw new Error(\"...\")`. Allowed only inside src/errors/. Allowed in tests with a comment `// allow-raw-throw: test scaffolding`."
---

## What this rule says

`throw new Error("message")` at a call site is fine for prototypes. It is wrong for shipped code. Replace with a typed error from a central `src/errors/` (or `src/server/errors/`) layer:

- Each named class extends a base `BetterAIError` carrying `code: string` (e.g. `BAI-101`), `httpStatus?: number`, and `cause?: unknown`.
- HTTP/MCP handler responses are built from the same classes — never inline `c.json({error: "unauthorized"}, 401)`. Handlers catch the typed error, map to an envelope, log the audit row.
- Error messages are constructed via factories: `Errors.bearerTokenMissing(path)`, not `new BearerTokenMissingError(path)` directly. Factories carry the canonical message + code.

Result: every error in the system has a stable code, a single place to read the message text, and a uniform shape on the wire.

## Why it matters

- **Stable error codes.** Clients (agents, dashboards) can match on `BAI-101` even when the human text drifts. Inline strings cannot.
- **Audit coherence.** Every error event needs the same shape (`{code, message, cause?, path?}`). Inline `c.json({error: "..."}, 401)` produces ad-hoc shapes that the audit pipeline can't aggregate.
- **i18n / docs.** When error UX matures (Phase 3.5 DX finding: agents need structured rejection responses to self-correct), the central source of truth is the codes table. Inline strings don't have a table.
- **Type safety.** Typed errors can be exhaustively handled in `catch`. Raw `Error` cannot.

## When this applies

**Applies:**
- Any module that throws or returns an error envelope under `src/`.
- All MCP tools and transport handlers — they must use typed errors mapped to the envelope.
- Bootstrap code that fails at startup (token loaders, schema validators, config parsers).

**Skip:**
- The `src/errors/` layer itself.
- Test scaffolding explicitly opting in via comment: `// allow-raw-throw: <reason>`.
- Third-party errors caught and re-thrown — wrap them in a typed error with `cause`, don't expose the raw third-party shape.

## What good looks like

```ts
// src/errors/bearer.ts
import { BetterAIError } from "./base";

export class BearerTokenMissingError extends BetterAIError {
  static readonly code = "BAI-101";
  static readonly httpStatus = 500;
  constructor(path: string) {
    super(BearerTokenMissingError.code, `bearer token not found at ${path}; install script must write it before startup`);
  }
}

export class UnauthorizedError extends BetterAIError {
  static readonly code = "BAI-201";
  static readonly httpStatus = 401;
}

export class HostNotAllowedError extends BetterAIError {
  static readonly code = "BAI-202";
  static readonly httpStatus = 401;
}
```

```ts
// src/errors/factories.ts
import { BearerTokenMissingError, UnauthorizedError, HostNotAllowedError } from "./bearer";

export const Errors = {
  bearerTokenMissing: (path: string) => new BearerTokenMissingError(path),
  unauthorized: () => new UnauthorizedError(UnauthorizedError.code, "unauthorized"),
  hostNotAllowed: () => new HostNotAllowedError(HostNotAllowedError.code, "host_not_allowed"),
} as const;
```

```ts
// src/server/auth/bearer.ts — call sites use factories
import { Errors } from "../../errors/factories";

function readToken(path: string): string {
  if (!existsSync(path)) throw Errors.bearerTokenMissing(path);
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw Errors.bearerTokenMissing(path);
  return raw;
}
```

```ts
// src/server/handlers/middleware-mapper.ts — one place maps typed errors to wire
import { BetterAIError } from "../../errors/base";

export const toEnvelope = (err: BetterAIError) =>
  ({ error: err.code, message: err.message });

// in route:
try { /* ... */ }
catch (err) {
  if (err instanceof BetterAIError) return c.json(toEnvelope(err), err.httpStatus ?? 500);
  throw err;
}
```

## Anti-patterns

```ts
// src/server/auth/bearer.ts:45-51 — found during /autoplan code review
function readToken(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `bearer token not found at ${path}; install script must write it before startup`,
    );
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    throw new Error(`bearer token at ${path} is empty`);
  }
  return raw;
}
```

Three different strings, no code. A monitoring system cannot distinguish "token missing" from "token empty" without grepping message text. Fix: two distinct factory calls (`Errors.bearerTokenMissing`, `Errors.bearerTokenEmpty`), each with its own code.

```ts
// src/server/auth/bearer.ts:88-94 — same file, two more inline shapes
if (!allowedHosts.has(host)) {
  return c.json({ error: "host_not_allowed" }, 401);
}
// ...
if (!match || !constantTimeEqual(match[1], token)) {
  return c.json({ error: "unauthorized" }, 401);
}
```

The `{error: "..."}` literal is a wire shape. It belongs in `src/dtos/error-envelope.dto.ts` or built via `toEnvelope(Errors.unauthorized())`. Inline = drift the moment a second handler does it differently.

## Migration path (when retrofitting existing code)

1. Create `src/errors/base.ts` (`BetterAIError` class with `code`, optional `httpStatus`, optional `cause`).
2. Allocate a code block per domain in `docs/DEBUGGING.md`:
   - `BAI-1xx` — bootstrap / config
   - `BAI-2xx` — auth / authz
   - `BAI-3xx` — contract violations (v1.5)
   - `BAI-4xx` — retrieval / corpus
   - `BAI-5xx` — audit / observability
3. Convert one module at a time. Bearer middleware first; it has the most call sites.
4. Add a `Errors` factory export.
5. Centralize the wire mapping in one helper.
6. Lint-check via regex: `throw new Error\("` outside `src/errors/**` should be zero.

## Related

- `[[layered-architecture-default]]` — `errors/` is a missing layer in the original 7; treat it as the 8th or fold it under `service/`.
- `[[no-catch-all-exception-masking]]` — typed errors enable narrow catches.
