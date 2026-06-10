---
id: config-from-env-not-hardcoded
title: Network/port/host config comes from env vars or dynamic discovery, not source literals
category: STANDARDS
domain: maintainability
severity: high
created: 2026-06-09
applies_when:
  paths:
    - "src/**/*.ts"
    - "src/**/*.tsx"
  intents:
    - "scaffold"
    - "new module"
    - "auth"
    - "transport"
    - "server"
    - "middleware"
  patterns:
    - "127\\.0\\.0\\.1"
    - "localhost:[0-9]+"
    - ":[0-9]{4,5}\""
    - "PORT\\s*=\\s*[0-9]"
related:
  - layered-architecture-default
  - no-magic-numbers-import-from-constants
check:
  kind: regex
  pattern: "(\"127\\.0\\.0\\.1|\"localhost:[0-9]+\"|:[0-9]{4,5}\")"
  notes: "Flags literal IP/host/port strings in source. Whitelist values that genuinely belong at the boundary (e.g. argv parsing) in a comment with `// allow-literal-host: <reason>`."
---

## What this rule says

Hardcoded IPs, hostnames, and ports do not belong in source files outside the env-parsing layer. They belong in:

1. **An env var** (`BETTERAI_PORT`, `BETTERAI_BIND_HOST`, `BETTERAI_ALLOWED_HOSTS`), read once at startup in a dedicated `config.ts` (or `constants/env.ts`).
2. **A dynamic-discovery layer** for *local* applications — bind to port `0`, ask the OS what was assigned, advertise it via a side channel (file, named pipe, MCP `/health` response). Hardcoding `7777` is wrong for a multi-instance local tool.

Production single-endpoint services may legitimately pin one port. Local toolkits should not.

## Why it matters

- **Conflict on the host.** Two BetterAI instances (per repo, per worktree) cannot both bind `7777`. The second silently fails.
- **CI flakiness.** Hardcoded `localhost:7777` in tests races with anything else on the box.
- **Multi-tenant blast radius.** A typo'd `7778` somewhere ships to staging unchanged because the value was never reviewed centrally.
- **The DNS-rebinding allowlist degrades.** When the port moves (and it will), the allowlist still says `7777` and rejects the legitimate client.

A single change ("we now run on 8888") becomes a grep-and-pray sweep instead of one env var bump.

## When this applies

**Applies:**
- Any TS/Node source under `src/` that names an IP, hostname, or port literally.
- Middleware, transport, auth modules.
- Any module that defines a "default" host/port set as a `const` literal.

**Skip:**
- The env-parsing layer itself (e.g. `src/config/env.ts`) reading the value once with a documented default.
- Test fixtures explicitly opting in via a comment: `// allow-literal-host: contract test, must not be configurable`.
- Generated code, vendored deps.

## What good looks like

```ts
// src/config/env.ts — the ONE place a default lives
export const config = {
  port: parseInt(process.env.BETTERAI_PORT ?? "0", 10),  // 0 = OS picks
  bindHost: process.env.BETTERAI_BIND_HOST ?? "127.0.0.1",
  allowedHosts: new Set(
    (process.env.BETTERAI_ALLOWED_HOSTS ?? "127.0.0.1,localhost")
      .split(",")
      .flatMap((h) => [`${h}:${actualPort}`])  // actualPort filled after bind
  ),
} as const;
```

```ts
// src/server/auth/bearer.ts — no literals
import { config } from "../../config/env";

const allowedHosts = opts.allowedHosts ?? config.allowedHosts;
```

For dynamic ports, bind first, then build the allowlist:

```ts
const server = await app.listen({ port: config.port, host: config.bindHost });
const actualPort = server.address().port;   // OS-assigned if config.port === 0
writeFile("/data/port", String(actualPort)); // advertise to clients
```

## Anti-patterns

```ts
// src/server/auth/bearer.ts:33-36 — found during /autoplan code review
const DEFAULT_ALLOWED_HOSTS = new Set([
  "127.0.0.1:7777",
  "localhost:7777",
]);
```

Three problems in two lines:
1. Port literal `7777` baked into the auth layer.
2. Allowlist cannot follow a port change.
3. Multi-instance broken by design.

**Fix order:**
1. Move the value to `src/config/env.ts`.
2. Make the port env-driven with `0` (OS picks) as the local default.
3. Build the allowlist *after* bind, using the actual port.
4. Document the env vars in `README.md` and `docs/AUTHORING.md`.

## Examples

**Counter-example (legitimately fine):** a one-line CLI demo that binds `127.0.0.1:0` and prints the URL. The literal is at the boundary, the value is `0`, no configurability needed.

**Counter-example (legitimately fine):** an integration test that asserts `Host: evil.example.com` is rejected. The literal is the test fixture, not config.

## Related

- `[[layered-architecture-default]]` — `constants/` is one of the 7 layers; env-read values live in `config/` or `constants/env.ts`.
- `[[no-magic-numbers-import-from-constants]]` — same intent at a finer grain.
