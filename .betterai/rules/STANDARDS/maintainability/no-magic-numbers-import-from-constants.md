---
id: no-magic-numbers-import-from-constants
title: No bare numeric literals in business logic; import from a constants layer
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-06-09
applies_when:
  paths:
    - "src/**/*.ts"
    - "src/**/*.tsx"
  intents:
    - "cache"
    - "config"
    - "limit"
    - "threshold"
    - "timeout"
related:
  - layered-architecture-default
  - config-from-env-not-hardcoded
check:
  kind: regex
  pattern: "[^a-zA-Z_.][0-9]{2,}[ ,)]"
  notes: "Flags integer literals >=10 in source. Excludes single-digit indices, common patterns (8/16/32-bit widths), and array literals. Allow with `// allow-magic: <reason>`."
---

## What this rule says

Numeric literals >= 10 (timeouts, port numbers, TTLs, max-sizes, cache caps, retry counts, byte widths above natural ones, sample sizes) belong in a `constants/` layer with a *name* that explains *what* and *why*, not at the call site.

Single-digit values (0, 1, 2, 3) and tightly-coupled local indices (`for (i = 0; i < arr.length; i++)`) are fine. The trigger is "this number controls behavior and would matter to someone reading the diff."

## Why it matters

- **Findability.** `LRU_DEFAULT_MAX = 256` is greppable; `256` is not (you'll find every accidental match across the repo).
- **Tunability.** A reviewer doesn't have to chase down what `60_000` means or where else it might also need to change — the named const is the single point of truth.
- **Documentation.** The constant's name is documentation: `CACHE_TTL_MS_DEFAULT` explains itself.
- **Diff legibility.** A PR that changes `256 → 512` in 4 places is invisible code review. A PR that changes `LRU_DEFAULT_MAX = 256 → 512` in one place is reviewable.

## When this applies

**Applies:**
- Any numeric literal that controls behavior at runtime.
- Timeouts, TTLs, cache sizes, batch sizes, retry counts, polling intervals.
- Anything used in a comparison (`if (x > 100)`) where the threshold is policy, not arithmetic.

**Skip:**
- Loop indices and local arithmetic (`x + 1`, `arr.length - 1`).
- Bit widths and natural sizes (`256` in a byte-rotation context is fine if next to a comment).
- Test fixtures explicitly opting in: `expect(result.length).toBe(7); // allow-magic: fixture cardinality`.
- Powers of 2 that are obviously a binary natural (e.g., `1024` in a buffer setup line).

## What good looks like

```ts
// src/server/cache/constants.ts
export const LRU_DEFAULT_MAX = 256;        // entries; tuned for ~64KB working set
export const LRU_DEFAULT_TTL_MS = 60_000;  // 60s; matches retrieve-context staleness budget
```

```ts
// src/server/cache/context-hash.ts
import { LRU_DEFAULT_MAX, LRU_DEFAULT_TTL_MS } from "./constants";

constructor(opts: ContextCacheOptions = {}) {
  this.lru = new LRUCache<string, CachedRetrieval>({
    max: opts.max ?? LRU_DEFAULT_MAX,
    ttl: opts.ttlMs ?? LRU_DEFAULT_TTL_MS,
  });
}
```

A reader of the constructor sees *what* the defaults express, not just *that* there are defaults.

## Anti-patterns

```ts
// src/server/cache/context-hash.ts:78-79 — found during /autoplan code review
this.lru = new LRUCache<string, CachedRetrieval>({
  max: opts.max ?? 256,
  ttl: opts.ttlMs ?? 60_000,
});
```

`256` and `60_000` are policy choices. A future change request "drop cache TTL to 30s for hot-reload mode" requires grepping for `60_000` everywhere — and you'll find it in five places because each module re-implemented the choice.

**Fix:** lift to `src/server/cache/constants.ts`; one named export per choice.

```ts
// src/server/auth/bearer.ts:107 — also flagged
for (let i = 0; i < a.length; i += 1) {
```

This `1` is fine — it's local arithmetic, not policy. Don't lift it.

```ts
// hypothetical handler timeout
setTimeout(retry, 5000);
```

`5000` is policy. Lift to `constants/timeouts.ts` as `RETRY_DELAY_MS = 5_000`.

## Examples

**Counter-example (legitimately fine):**

```ts
return c.json(payload, 200);
```

HTTP status codes ARE the names. `200`, `401`, `404`, `500` are unambiguous in context. Lifting them to constants is cargo-cult — but if you wrap them in a typed-error system (see `[[typed-errors-from-errors-layer]]`), the wrapping comes from the error class's `httpStatus`, not a bare literal in the handler.

**Counter-example (legitimately fine):**

```ts
const idx = path.indexOf("/", 1);  // skip leading slash
```

The `1` is offset arithmetic with a comment. Reasonable.

## Related

- `[[layered-architecture-default]]` — `constants/` is a first-class layer in the BetterAI house style.
- `[[config-from-env-not-hardcoded]]` — for *deployment-tunable* values, env vars beat constants; this rule is for *code-tunable* policy values.
