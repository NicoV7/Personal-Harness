# Refactor review — layers + restructure diff (2026-06-10)

Focused multi-agent review of the change since `b12d7a2^` (constants/errors/config layers, dotenv, router-parser fix, capability-flat restructure). The refactor was billed behavior-preserving; all 198 unit tests stayed green, but the review found regressions the suite can't see. **2 high · 3 medium · 6 low.**

## HIGH

1. **`scripts/update-component-docs.mjs:25-34` — doc-stamp hook silently dead** (D10, auto-fix). `PATH_TO_COMPONENT` still keys on `src/server/corpus/`, `src/server/retrieve/`, … but those dirs moved to `src/corpus/`, `src/retrieval/`, etc. `pickComponent()` does `startsWith(prefix)`, so no moved file matches → the pre-commit doc-stamp is a no-op for the whole core. A mechanical `s/server//` is insufficient: `retrieve/`→`retrieval/` was renamed and `main.ts`→`app.ts`. **FIXED** (this commit).
2. **`src/retrieval/router.ts` — the just-fixed parser has zero tests** (D9). `parseYaml`/`DomainRouter.fromFile` are exercised by no unit test; the `parentIndent=-1` fix that revived routing is pinned only by the web-agent A/B. A regression back to `parentIndent=0` would pass all 198 tests. **FIXED** — added `router.test.ts` (this commit).

## MEDIUM

3. **`src/errors/index.ts:83-98` — two MCP error `.code`s silently changed** (D1). `ValidationError` `VALIDATION_ERROR`→`BAI-301`, `RuleNotFoundError` `RULE_NOT_FOUND`→`BAI-401` — while every *other* retrofitted error kept its legacy `.code` and put the BAI id on `.baiCode`. Inconsistent + a wire-contract shift. **FIXED** — legacy `.code` restored, BAI id on `.baiCode`.
4. **`src/retrieval/router.ts:120` — malformed-tuple `[emptyOrFirst()] as never` still corrupts nested case** (D1). The `parentIndent=-1` fix removed this only at top level; a nested empty-value-child-then-dedent stores the raw `[{},0]` tuple instead of `{}`. Latent (shipped `domain-router.yaml` doesn't trigger it) but real. **FIXED** — returns a well-formed `[{}, j]`; covered by new router test.
5. **`src/retrieval/index.ts` — routing change unpinned** (D9). Fixing the parser changed which rules surface (more domains now pass `capByDomain`); no test pins the new routing. **FIXED** — router test asserts the domain sets.

## LOW (report-only)

- `docs/components/*.html` still cite `src/server/*` file paths (stale doc meta; auto-stampable once finding #1 lands).
- `src/errors/index.ts` `Errors` factory + `src/errors/base.ts` `toEnvelope` are exported but unused (dead until the transport routes envelopes through them; `toEnvelope`'s `{error,message}` shape also disagrees with the inline `{error,retry_after_ms}` 429 at `http-sse.ts:215`).
- `GateInProgressError`/`NoGateInProgressError` gained `.code` BAI-110/111 they never had (additive; low risk).
- `AuditIoError` with no cause no longer has a present-but-undefined `.cause` own-property (cosmetic).
- `grep.ts:127/136/142` — constant extraction skipped `scoreMemory` (raw `+= 2`/`+= 1`). **FIXED** (trivial completeness).
- `src/index.ts` dotenv: `loadEnvFile()` runs after hoisted imports evaluate (benign today — all env reads are lazy/in-function) and has no try/catch (a malformed `.env` aborts startup). Reported; not a current regression.

## Net

Runtime behavior for the shipped configuration is intact (the green suite is right about that), but the move broke the doc-stamp build tool and shifted two error `.code` contracts under the radar — exactly the class of regression that needs a review, not a test run. High + medium items fixed in the follow-up commit; lows left as report-only.
