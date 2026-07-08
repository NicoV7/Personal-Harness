---
id: fail-loud-no-retries
title: Fail loud on infrastructure errors - no retries, no backoff, no fallbacks
category: STANDARDS
domain: error-handling
severity: high
created: 2026-07-06
applies_when:
  paths: ["**/*.py", "**/*.ts", "**/*.js"]
  intents:
    - error handling
    - http client
    - provider integration
    - resilience
    - implement
related:
  - no-catch-all-exception-masking
  - config-explicit-no-defaults
---

## What this rule says

When a dependency call fails (database, cache, embedding provider, HTTP
service), make ONE attempt, raise a typed error from the errors layer, and log
loudly. Do not add retry loops, exponential backoff, circuit breakers, or
silent fallbacks to a degraded mode. The error message must tell the operator
exactly what to do next (for BetterAI infra: "run `betterai start`").

Retries are acceptable ONLY at a genuinely unreliable third-party boundary
(e.g. a vendor API with documented transient 429/503 behavior you cannot fix),
and then they must be explicitly bounded (fixed max attempts), explicitly
logged per attempt, and visible in the code as a deliberate, commented
decision - never a reflexive wrapper.

## Why it matters

Defensive retries and fallbacks convert hard failures into soft, invisible
ones. A retry loop around a misconfigured connection string turns a 1-second
crash into a 30-second hang with the same outcome. A fallback to a degraded
path (cached data, offline index, empty result) means the system keeps
"working" while serving wrong answers, and nobody investigates because nothing
crashed. Loud, immediate failure with a prescriptive message gets fixed in
minutes; masked failure gets discovered in weeks, downstream, as data damage.

## When this applies

- Any call across a process boundary: Redis, Postgres, HTTP providers, Docker.
- Any `except`/`catch` that would re-invoke the failed operation.
- Any code path that would substitute a "lesser" result when the primary
  dependency is down (offline mode, stale cache, empty default).
- Boot-time dependency checks: one attempt, loud log, typed error.

Does NOT apply to: user-facing input validation (that is a domain error, not
an infra error), or an explicitly bounded retry at a documented-flaky vendor
boundary as described above.

## What good looks like

One attempt, typed error, prescriptive message (language-agnostic; Python
shown because the harness backend is Python):

```python
async def embed(self, texts: list[str]) -> list[list[float]]:
    """One attempt only: an unreachable provider must surface immediately."""
    response = await self._client.post("/v1/embeddings", json=payload)
    if response.status_code != 200:
        raise Errors.embedding_provider(
            f"OpenRouter returned {response.status_code}; "
            "check the key and run `betterai doctor`"
        )
    return parse_embeddings(response.json())
```

## Anti-patterns

Wrong - reflexive retry loop with backoff masking a permanent failure:

```python
async def embed(self, texts):
    for attempt in range(5):
        try:
            return await self._client.post("/v1/embeddings", json=payload)
        except Exception:
            await asyncio.sleep(2 ** attempt)  # hangs 30s, then fails anyway
    return []  # and now the caller indexes nothing, silently
```

Fixed: see "What good looks like" - one attempt, typed error, loud message.

Wrong - silent fallback to a degraded mode:

```python
try:
    return await self._redis_query(query)
except ConnectionError:
    return self._local_bm25(query)  # wrong results, nobody notices
```

Fixed: raise `Errors.stack_unavailable("redis unreachable; run `betterai start`")`.

## Examples

The acceptable exception, done correctly - bounded, logged, commented:

```python
# DELIBERATE RETRY: vendor documents transient 429s on this endpoint.
# Bounded to 3 attempts; every attempt is logged; final failure is typed.
for attempt in range(1, 4):
    response = await client.post(url, json=body)
    if response.status_code != 429:
        break
    logger.warning("vendor 429, attempt %d of 3", attempt)
if response.status_code != 200:
    raise Errors.embedding_provider(f"vendor failed after 3 attempts: {response.status_code}")
```

The comment, the bound, and the per-attempt log are all mandatory. If any of
the three is missing, the retry is a masking bug, not a resilience feature.
