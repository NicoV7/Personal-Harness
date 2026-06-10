# review-fleet — BetterAI full-repo review (2026-06-10)

Produced by the `review-fleet` skill: 7 module scanners + 2 cross-cutting (magic-numbers, duplication) + 4 adversarial red-team agents → organizer (dedupe + adversarial verify + fix-wave grouping). Raw structured output: [`review-fleet-findings-raw.json`](review-fleet-findings-raw.json).

**Verdict:** structurally sound (198 tests, 0 typecheck errors) but **2 critical security holes on the tool surface** + a cluster of magic-number/duplication debt the repo's own rules forbid. **Counts (deduped/verified): 2 critical · 11 high · 17 medium · 10 low.**

> Security (D4) was reviewed by the static adversarial agents only. The live-DAST stage (**Shannon**) was **not run** — `ANTHROPIC_API_KEY` is unset on this machine (docker ✓, node ✓, shannon 1.5.0 ✓). Per the fail-loud policy it was not silently skipped. To run it: `export ANTHROPIC_API_KEY=…` then `/review-fleet --target-url http://127.0.0.1:7777`.

## CRITICAL (fix before any shared/dogfooding use) — report-only, need a human eye

| # | File:line | Issue |
|---|---|---|
| C1 | [check-file.ts:130](../../src/mcp-tools/check-file.ts#L130) | **Arbitrary host-path read.** `readFileSync(path)` runs on the caller-supplied path with **no containment check** vs `BETTERAI_PROJECTS_ROOT`. A bearer-holding caller passes `path=/data/token` or `/etc/passwd`; matching lines come back in `violations[].evidence` → **token/secret exfiltration**. Fix: `realpathSync(resolve(path))` must be inside `resolve(projectsRoot)` else throw `PathOutsideProjectsRoot`. |
| C2 | [record-memory.ts:243-258](../../src/mcp-tools/record-memory.ts#L243) | **Frontmatter injection.** `formatScalar` escapes `\` and `"` but **not newlines**. An agent-supplied multi-line `title`/`project`/array item breaks out and injects column-0 keys; since the reader is last-write-wins, injected `kind:`/`durability:` override the real ones on read-back — and the audit log records the *submitted* value, so disk diverges from the audit trail. Fix: newline-escape scalars (or adopt the `yaml` package), or `.regex(/^[^\n\r]*$/)` on the string fields. |

## HIGH (11) — report-only with fix sketches

| File:line | Dim | Issue |
|---|---|---|
| [check-file.ts:176-180](../../src/mcp-tools/check-file.ts#L176) | D5 | **ReDoS**: corpus-supplied regex run per-line, no timeout/length cap; `(a+)+$` on a long line stalls the event loop for all sessions. |
| [embeddings.ts:207](../../src/server/retrieve/embeddings.ts#L207) | D5 | Unbounded embedding cache (`Map`, no max/TTL) keyed on attacker-controlled intent text → OOM. |
| [http-sse.ts:186-208](../../src/server/transport/http-sse.ts#L186) | D5 | **Orphaned McpServer leak**: `server.connect()` happens before the limiter check; a 429'd `initialize` never enters the session map and is never closed. |
| [http-sse.ts:173](../../src/server/transport/http-sse.ts#L173) | D5 | POST `/mcp` parses the body with no size/nesting limit (no `bodyLimit`, no `.max()` on intent/recent_diff) → OOM. |
| [repo-detector.ts:81-86](../../src/server/scope/repo-detector.ts#L81) | D5 | RepoDetector cache grows unbounded across distinct caller paths (hot path, no LRU/sweep). |
| [_shared/frontmatter.ts:54-193](../../src/cli/_shared/frontmatter.ts#L54) | D6 | **Two divergent YAML parsers** (CLI vs server `reader.ts`): disagree on `>` fold, empty-value, throw-vs-skip → a file can pass `betterai validate` yet load broken/dropped on the server. |
| [validate.ts:139-225](../../src/cli/validate.ts#L139) | D1 | CLI `validate` checks presence/enums only — never `check.kind`, array shapes, types — so it exits 0 on rules the server's Zod silently drops. |
| [cli-frontmatter.test.ts (missing)](../../src/cli/_shared/frontmatter.ts) | D9 | CLI frontmatter parser has **zero** direct test coverage. |
| [env.ts:158-162](../../src/contracts/env.ts#L158) | D1 | Env drift guard checks **types not default values** — defaults in `main.ts` vs contract can diverge undetected. |
| [main.ts:104-128](../../src/server/main.ts#L104) | D2 | `main.ts` re-declares the whole env schema inline, re-hardcoding every host/port/path the env layer is supposed to own. |
| [gate.ts:182](../../src/cli/gate.ts#L182) | D2 | Health-probe URL hardcodes `127.0.0.1` instead of `DEFAULT_BIND_HOST`. |

## MEDIUM (17) / LOW (10)

Full detail in the raw JSON. Themes: more magic-number sites (grep score weights, `why.ts` ranking weights, `top_k` caps across the 4 retrieve tools, repo-detector TTL, walk-up `64`, `MS_PER_DAY` re-spelled in gate/replay/why); correctness (`>` block-scalar not folded; flow-array comma split corrupts quoted items; duplicate ids within a scope silently kept); error-handling (no central `src/errors/` layer; `closeAllSessions` resolves before closes finish; 500 leaks internal error messages; `allowedHostsFromEnv` returns empty Set → bricks auth on a `,`-only value); a second repo-root walk-up impl in `cli/_shared/repo-root.ts` that diverges from the server's; and test gaps (router YAML parser, record_memory write path, idle-session GC, limiter→429 integration).

## APPLIED (auto-fix wave — landed on main, green-gated)

Commit `refactor(cache,router): extract magic-number defaults to named constants` — new [`src/server/cache/constants.ts`](../../src/server/cache/constants.ts) (`LRU_DEFAULT_MAX`, `LRU_DEFAULT_TTL_MS`, `LIMITER_DEFAULT_MAX_IN_FLIGHT`, `LIMITER_DEFAULT_QUEUE_MAX`) consumed by `context-hash.ts`, `cache/index.ts`, `connection-limiter.ts`; router default domains/4/12 lifted to shared module constants. Closes the highest-confidence D2/D6 findings incl. the no-magic-numbers rule's own cited anti-pattern. Pure refactor; typecheck 0, 198 tests pass. Remaining magic-number sites left report-only (lower confidence or cross-file shared-constant design calls).

## Recommended next waves (need approval / judgment)

1. **Security criticals C1+C2** — small, surgical, but security-sensitive: path containment in `check-file`, newline-safe serialization in `record-memory`. Add `check-file.test.ts` + `record-memory.test.ts` (both have zero coverage today).
2. **Unify the two YAML parsers** + make CLI `validate` use the server Zod schemas (kills the "validates in CLI, breaks on server" class). Justifies a new corpus rule `single-source-parser`/`no-duplicate-parsers`.
3. **Resource bounds**: LRU-cap the embedding + repo-detector caches; `bodyLimit` + input `.max()` on `/mcp`; fix the orphaned-session leak (acquire permit before connect).
4. **Run Shannon** once `ANTHROPIC_API_KEY` is set — though BetterAI's localhost JSON-RPC surface is thin; Shannon's high-value target is the portfolio website from the EVAL-HARNESS plan.
