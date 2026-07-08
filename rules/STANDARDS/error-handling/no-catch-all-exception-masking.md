---
id: no-catch-all-exception-masking
title: Don't swallow errors with catch-all try/catch returning fallback values
category: STANDARDS
domain: error-handling
severity: high
created: 2026-06-09
applies_when:
  paths: ["**/*.ts", "**/*.js", "**/*.py"]
  intents: ["error-handling", "defensive-programming", "exception-handling"]
check:
  kind: ast-grep
  pattern: "try { $$$ } catch ($_) { return {}; }"
related:
  - no-defensive-optional-chains
  - no-redundant-internal-validation
  - fail-loud-no-retries
source: RULES.md §7, §4.1
---

## What this rule says

Don't wrap operations in a broad `try/catch` that swallows the error and returns a generic fallback (empty object, empty string, `null`, `undefined`, or a hard-coded "default"). Either:

1. Let the error propagate to a top-level boundary (request handler, job runner, error tracker), OR
2. Catch a *specific* exception type that you can take a *specific* recovery action on (retry, fall back to cache, surface a user-facing message).

The anti-pattern produces three failure modes:

- **Suppressed bugs.** A connection error, a syntax error in `renderDashboard`, and a genuine missing-user condition all become the same `{}` — logs go silent, dashboards stay green, the bug ships.
- **Zombie state.** Code downstream of the empty fallback runs against bad data, often producing a *second* bug far from the root cause.
- **Lost telemetry.** The error tracker (Sentry, Datadog, console) never sees the exception. Future you cannot debug what you cannot see.

Defensive retries and backoff loops are a masking variant of the same anti-pattern: re-invoking a failed call instead of surfacing the error hides the failure exactly like returning `{}` does, just slower. A retry wrapper around a permanent failure (bad credentials, wrong host, missing table) converts a 1-second crash into a multi-second hang with the same outcome and less signal. Retrying is only legitimate under the narrow conditions in `fail-loud-no-retries` — a documented-flaky third-party boundary, explicitly bounded, logged per attempt; everywhere else, one attempt and a typed error.

## Why it matters

A swallowed exception is worse than a crash. A crash gets investigated; a silent empty object gets shipped to production and corrupts downstream data for months before anyone notices. The cost of recovering from "we've been writing `{}` to the analytics pipeline for six weeks" is orders of magnitude higher than the cost of a 500 response.

This rule is `severity: high` because the failures are silent, cumulative, and discovered late. Most other style rules cost a code review comment; this one costs a data backfill.

## When this applies

Applies to any `try/catch` (TS/JS) or `try/except` (Python) where:

- The catch block has no body, OR
- The catch block returns a literal fallback (`{}`, `[]`, `""`, `0`, `null`, `undefined`, `false`), OR
- The catch block only logs and continues with a fallback, AND
- The caught type is the universal base (`Error`, `Exception`, `BaseException`, bare `except:`).

Does NOT apply when:

- You catch a specific subclass (`PrismaClientKnownRequestError`, `ZodError`, `FetchError`) and take a specific action, OR
- You catch at a true boundary (Express error middleware, Next.js `error.tsx`, a job-queue worker's top loop) and forward to an error tracker before re-throwing or returning a structured failure.

## What good looks like

Let errors bubble to the nearest *real* boundary. If you must handle them inline, narrow the catch and document the recovery:

```typescript
// Boundary: the request handler is the right place to catch.
// The service function does not try to "rescue" itself.
async function getUserDashboard(userId: string): Promise<Dashboard> {
  const user = await fetchUserFromDatabase(userId); // throws on connection error
  return renderDashboard(user);                     // throws on render bug
}

// At the boundary (Express, Next route handler, etc.):
app.get("/dashboard/:userId", async (req, res, next) => {
  try {
    const dashboard = await getUserDashboard(req.params.userId);
    res.json(dashboard);
  } catch (err) {
    next(err); // -> error middleware -> Sentry -> 500 response
  }
});
```

When you *do* want to recover inline, catch the specific class and explain the choice:

```typescript
try {
  return await fetchPricingFromVendor();
} catch (err) {
  if (err instanceof VendorTimeoutError) {
    // Specific, actionable: fall back to last-known cache, log the degradation.
    logger.warn({ err }, "vendor timeout, serving cached pricing");
    return cachedPricing;
  }
  throw err; // Everything else still bubbles.
}
```

## Anti-patterns

The original example from `RULES.md §4.1` (JavaScript):

```javascript
function getUserDashboard(userId) {
  try {
    const user = fetchUserFromDatabase(userId);
    return renderDashboard(user);
  } catch (error) {
    // Swallows a potential connection, syntax, or logic error entirely
    return {};
  }
}
```

What goes wrong, step by step:

1. `fetchUserFromDatabase` throws because the database connection pool is exhausted.
2. The catch returns `{}`.
3. `renderDashboard` is never called, but the caller receives a "dashboard" — an empty one.
4. The user sees a blank page. Nothing is logged.
5. The on-call engineer sees no spike in 500s and no Sentry alert. The pool stays broken.

The fix is to remove the rescue:

```typescript
function getUserDashboard(userId: string): Dashboard {
  const user = fetchUserFromDatabase(userId);
  return renderDashboard(user);
}
```

Sibling anti-pattern — "log and swallow" is not better than "swallow":

```typescript
// Still wrong. The log is local, the caller still gets bad data.
try {
  return await loadConfig();
} catch (err) {
  console.error("config failed", err);
  return {}; // <-- caller now operates on an empty config
}
```

## Examples

TypeScript-flavored good vs bad for a typical service-layer function:

```typescript
// BAD
async function getInvoice(id: string): Promise<Invoice> {
  try {
    return await db.invoice.findUniqueOrThrow({ where: { id } });
  } catch {
    return {} as Invoice; // lies about the return type and hides Prisma errors
  }
}

// GOOD — narrow catch, specific recovery, everything else propagates.
async function getInvoice(id: string): Promise<Invoice | null> {
  try {
    return await db.invoice.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return null; // "not found" is a real domain value, not an error
    }
    throw err; // connection errors, syntax errors, anything unknown — bubble up
  }
}
```

The good version is honest in three ways: the return type says "could be null", the catch handles exactly one known case, and unknown failures are visible to the error tracker.
