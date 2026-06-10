# Reliability Test Gap Analysis — Post-Wave-5

**Generated**: 2026-06-09 (end of session, Wave 5 complete)
**Baseline**: 7 test files, 66 tests, 100% passing, 1,188 LOC of test code.
**Production code**: 14 server modules + 8 CLI verbs + 7 MCP tools + 2 meta-validators.

## Why this doc exists

BetterAI is an agent harness. Agents are notoriously hard to monitor with a human in the loop:

- A subagent that silently fails a `retrieve_context` call still produces output (the agent goes on without rules) — the human sees normal-looking code, not a failure.
- A subagent that calls `retrieve_context` and ignores the returned rules (the M2 failure mode) leaves no externally visible signal until the diff is reviewed (and even then, only catchable if the diff is small).
- A subagent that races with siblings on cache writes can produce *different* retrievals for the same query inside one workflow — without anyone noticing.
- A disk-full or stale-token failure on the server side can blackhole an entire dogfooding gate's worth of audit data — and the agent's outputs look exactly the same to the user.

Test gaps in this environment aren't just code smells. They are **the failure-monitoring infrastructure** that catches the things humans never will. This document inventories what we have, what we don't, and ranks the missing tests by reliability ROI.

## Threat model

Six classes of failure that BetterAI must catch on its own (no human in the loop):

1. **Silent-output failures**: server returns a degraded result (empty list, stale snapshot, malformed envelope) without raising an error. The agent reads it as truth.
2. **Race conditions across subagents**: multiple subagents share the in-memory ContextCache + audit file; concurrent writes / cache evictions can produce non-deterministic retrievals.
3. **Filesystem / IO partial failures**: audit append succeeds for the first 200 bytes, then ENOSPC. Token file rotates mid-flight. Corpus file is removed while indexed.
4. **Schema / contract drift between waves**: the recurring Wave-3 failure mode. Wave 5 fixed the existing drift; nothing prevents the next wave from re-introducing it.
5. **Agent-side compliance failures**: agent receives rules and doesn't apply them (M2). Server has no way to *prove* compliance happened — only to detect *missing* `apply_compliance` events once Item 2.5 lands.
6. **Adversarial inputs**: bearer-token timing attacks, host-header spoofing for DNS rebinding, oversized retrieve_context contexts, frontmatter injection in user-authored rules.

This document focuses on classes 1, 2, 3, 5, 6. Class 4 (cross-wave drift) is structural and is being addressed by Item 1b (`src/contracts/` Zod extraction).

## Test coverage map (what we have)

| Module | LOC | Test file | Test count | Coverage style |
|---|---|---|---|---|
| `src/server/scope/repo-detector.ts` + `detect.ts` | ~120 | `scope-detection.test.ts` | 5 | Happy + edge (nested git, non-git, empty input) |
| `src/server/cache/context-hash.ts` + `index.ts` | ~165 | `cache.test.ts` | 8 | Hash determinism + LRU eviction + scope isolation |
| `src/server/audit/jsonl.ts` | ~150 | `audit-schema.test.ts` | 5 | Parent-session invariant validation only — no IO behavior |
| `src/server/main.ts` + `transport/http-sse.ts` + `auth/bearer.ts` | ~600 | `server-boot.test.ts` | 4 | Boot + /health 200 + /retrieve 401 (no token / bad token) |
| `src/cli/validate.ts` | ~250 | `cli-offline.test.ts` | 3 | Validate exit code on good/bad corpus, no env vars |
| `src/_meta-validators/rule-schema.ts` | ~480 | `rule-schema.test.ts` | 36 | Validator branch coverage (the bulk of test code) |
| `src/mcp-tools/retrieve-context.ts` | ~250 | `retrieve-context.test.ts` | 4 | Merge + override + global-only fallback |

**Total executable production code under test**: roughly 60% of server LOC has *some* test exercise; ~20% of CLI LOC.

## Coverage gaps by module — ranked by reliability ROI

### Tier 1: **Critical reliability gaps** (must fix before Phase 2 dogfooding)

#### G1. `ConnectionLimiter` — **0 tests** (highest ROI)

`src/server/cache/connection-limiter.ts` — 93 LOC, semaphore that caps 16 concurrent retrievals and queues up to 64. Beyond the queue: throws `TooManyInFlightError` (HTTP 429).

**Why critical**: this is the single piece of code between BetterAI and "a multi-agent fleet brings the server to its knees." Untested.

Missing tests:
- Acquires permit when in-flight < max → resolves immediately.
- Queues when in-flight = max, queue < queueMax → resolves on `release()`.
- Throws `TooManyInFlightError` when queue = queueMax.
- Permits flow to next waiter on release (no double-release, no leak).
- Concurrent acquire from N=100 promises — none deadlock, all eventually resolve OR throw 429, in-flight ≤ max throughout.
- Failure in `fn` still releases the permit (the try/finally is correct but unverified).
- `stats` getter reports accurate state under load.

Estimated effort: 1 day.

#### G2. `MissedRetrievalDetector` — **0 tests**

`src/server/audit/missed-retrieval.ts` — the lever-b implementation for "agent retrieved but didn't follow up with `check_file`." It IS the v1.0 compliance-detection mechanism.

**Why critical**: lever-b is what makes the auto-retrieve audit story work (multi-agent eng review §1.6). Without tests, regressions are silent. Wave 5 didn't touch this file but Item 3 (applied-rule contract) explicitly references it as the spec to extend.

Missing tests:
- Records a retrieve event with `parent_agent_session_id` X → no missed event.
- Records a `check_file` without prior retrieve in same `parent_agent_session_id` window → emits `missed_retrieval` audit event.
- Records a retrieve, then a `check_file` 30s later (still within window) → no missed event.
- Records a retrieve, then a `check_file` 10min later (outside window) → emits missed.
- Multiple subagents under same parent — each tracked independently? Or rolled up?
- Clock injection works (the option exists for tests; not exercised).

Estimated effort: ~half day.

#### G3. `JsonlAuditWriter` filesystem partial-failure behavior — **partial tests**

`src/server/audit/jsonl.ts` — the audit writer is the *only* observability surface BetterAI exposes. If it silently fails, the entire compliance story disappears.

Currently tested: shape validation (`validateAuditEvent`), and that the lazy-init lets `server-boot.test.ts` pass. Not tested: the file-IO failure modes.

Missing tests:
- `mkdirSync` fails with EACCES → writer surfaces a clear error (not a silent swallow).
- `appendFileSync` after disk-full (ENOSPC) → behavior? Crash? Drop? Buffer?
- Mode 0o640 actually applied — re-readable by group, not world.
- Concurrent appends from N processes / N async writes — atomic line append? `fs.appendFileSync` is supposedly atomic on POSIX for writes < PIPE_BUF (4KB); audit events can exceed that.
- Rotated file (someone moves audit.jsonl during run) → does the writer re-open or fail?
- Append after file's parent dir was removed.

Estimated effort: 1 day (some tests need mocked fs).

#### G4. `bearerMiddleware` adversarial-input coverage — **happy path only**

`src/server/auth/bearer.ts` — the security boundary. Currently tested: token present+correct → 200; missing → 401; wrong → 401. Not tested: the attacks the middleware was designed to prevent.

Missing tests:
- Authorization header malformed: `Bearer ` (no token), `bearer foo` (lowercase), `Basic foo`, multiple values → all 401.
- Host header missing entirely → 401 (DNS rebinding defense).
- Host header spoofed: `evil.example.com` → 401.
- Host header with port mismatch: `127.0.0.1:8888` when server listens on 7777 → 401.
- Token comparison is actually constant-time (under a microbench, varying-length wrong tokens show no timing signal).
- `onBypass` is invoked for `/health` and only `/health`, never for protected routes.
- Token file rotated to a new value at runtime → middleware uses the old or new? (Currently caches at construction — possibly a bug.)
- Empty token file post-rotation → middleware's behavior?
- Token file permissions tightened (0o600) verified — server rejects 0o644 tokens? (Currently no check.)

Estimated effort: 1 day. Several tests will reveal real bugs.

#### G5. The 5 fault tolerance modes (M1-M5) — **0 tests**

Per the v1.5 plan, M1-M5 each get a smoke test as a Wave-5+ deliverable. As of this session, **no fault-tolerance mode has any test coverage** — the modes were designed but never proved.

| Mode | What it is | Has test? |
|---|---|---|
| **M1** search returns nothing | Empty rule set; agent should still get a structured "no_match" response | No |
| **M2** agent ignores retrieved skill | Server can detect (lever-b); requires Item 2.5 closing-the-loop | No (lever-b detector itself is also untested → G2) |
| **M3** DB / corpus reader is not up | Circuit breaker + last-known-good snapshot fallback | No infrastructure even exists yet |
| **M4** skill loads contradicting agent's prior write | Ordering invariant + audit-log warning | No infrastructure yet |
| **M5** sibling agent fails mid-impl; parent's context is stale | Checkpoint contract + stale-context warning | No infrastructure yet |

**Why critical**: M1 will fire on any agent that asks for rules with an off-by-one intent. M3 will fire the moment the corpus reader hits a permission denied or rm -rf of the mounted volume. These are not edge cases.

Estimated effort: M1 is half a day (test + the `reason: "no_match"` first-class response shape). M3 needs the `RetrievalTransport` interface from the v1.5 plan first; ~2 days total once that lands. M2/M4/M5 wait on Item 2.5.

### Tier 2: **Important reliability gaps** (close during Phase 1.5 / Item 6)

#### G6. `CorpusReader` snapshot semantics under concurrent calls — **untested**

`src/server/corpus/reader.ts` — caches a `CorpusSnapshot` on first `read()`. Subsequent calls reuse it. View methods (`fetchRules/Skills/Memories/...`) call `read()` internally.

Missing tests:
- 100 concurrent `fetchRules()` calls on a cold reader → only one disk walk, all calls share the same snapshot reference (no duplicate work).
- `read()` after the underlying directory changes — does the reader detect? Or serve stale forever? (Likely the latter; if so, document.)
- `read()` when a rule file is unreadable mid-walk — does the snapshot include the others or error out entirely?
- `read()` on an empty corpus dir → returns empty snapshot, not error.
- Snapshot invalidation strategy — there is none. Verify by test that the reader's contract IS "serve forever; restart to refresh."

Estimated effort: ~half day. Findings probably document a contract rather than fix a bug.

#### G7. `OrchestratorRetriever` (`src/server/retrieve/index.ts`) — **0 direct tests**

The orchestrator wires `repoDetector` + `corpusReader` + `cache` + `auditLog` into the retrieve flow. Tested transitively through `retrieve-context.test.ts` but no isolation tests.

Missing tests:
- Cache hit emits audit with `cache_hit: true` (Wave 5 added the field; not exercised).
- Cache miss emits audit with `cache_hit: false` and a fresh `latency_ms`.
- Scope mode `global` queries only global; `repo` queries only repo (or falls back to global on no repo); `merged` queries both with override.
- Audit event shape includes all required fields under all paths (cache hit, cache miss, no repo, no global).
- `emitAudit` is called exactly once per `retrieve()` (no double-audit).
- `repoDetector` returns null → orchestrator falls back to global.
- Adversarial input: `ctx.file_paths = []` (empty), `intent = ""` (empty) → still produces an envelope, doesn't crash.

Estimated effort: 1 day.

#### G8. `DomainRouter` + `grep` retrieval — **0 direct tests**

`src/server/retrieve/router.ts` (256 LOC) and `src/server/retrieve/grep.ts` are the actual ranking + matching logic. Surfaced only through `retrieve-context.test.ts`'s integration path.

Missing tests:
- Domain mapping correctness: an intent of "rename a variable" maps to the `naming` domain.
- Multi-domain intent routes to multiple domains.
- Empty intent → falls back to all domains OR a default; verify.
- Grep matcher: rule with `applies_when.paths: ["src/**/*.ts"]` matches `src/foo.ts`, does not match `src/foo.py`.
- Grep matcher under the broken Wave-1 frontmatter (string instead of array) — produces a clear validation error, not silent skip.
- Score function: higher severity > lower severity for the same match strength.
- Recency tiebreaker: newer rule wins when severity + match are equal.

Estimated effort: 1.5 days. The router has the most subtle logic in the codebase; tests here pay off long-term.

#### G9. CLI verbs (`gate`, `init`, `new`, `replay`, `status`, `why`) — **0 tests**

Only `validate.ts` has a test. The others are gated by Wave-4's "tsx/CJS path or missing build step" issue, which we side-stepped by fixing `validate` directly.

Missing tests:
- `gate --start` writes the timestamp file; `--status` reports days elapsed; `--week N` enforces the criteria. (Per v1.5 plan Item 4 — needed before dogfooding gate starts.)
- `init` is idempotent re-run; doesn't clobber existing rules.
- `new rule|skill|memory` produces validator-compliant frontmatter.
- `replay --since 5d` filters correctly across timezone boundaries.
- `status` reads counts without booting the server.
- `why` simulates retrieve_context against the offline corpus.

Estimated effort: 2-3 days.

### Tier 3: **Defensible gaps** (track for v1.6+)

#### G10. `transport/http-sse.ts` `/mcp` dispatcher

Currently a placeholder. When the SDK transport lands, it needs tests for: malformed JSON-RPC envelope; unknown tool name; tool throws → JSON-RPC error envelope; streaming (`/mcp/sse`) under client disconnect; backpressure when SDK pushes faster than client reads.

Estimated effort: 1 day after the implementation lands.

#### G11. End-to-end multi-agent flows

A real test that spawns N=4 subagents via Claude Code's Agent tool, each invoking `retrieve_context` against the BetterAI MCP, then asserts:
- 4 events share a `parent_agent_session_id`.
- All 4 events have distinct `tool_call_id`.
- No cross-cache poisoning (different agents in different `repo_root_detected` get different cache keys).
- `ConnectionLimiter` doesn't 429 (under N=4 it shouldn't).
- Under N=100 it DOES 429 cleanly (no deadlock).

Gated by G10 (`/mcp` dispatcher).

Estimated effort: 2 days once gated work lands.

#### G12. Rule frontmatter shape robustness

The 18 frontmatter shape issues surfaced at corpus-load this session (Wave-1 seed rules with string-or-null where array expected) — the server logs them and proceeds. No test verifies this graceful-degradation path.

Missing tests:
- Rule with `applies_when.paths: null` is dropped from candidate pool with a log; other rules still load.
- Rule with totally absent frontmatter is dropped; load doesn't crash.
- Corpus with 100% invalid rules → server still boots (returns empty `fetchRules`).
- A repo override of a globally-invalid rule — does the override still apply if the repo version is valid?

Estimated effort: half a day. Worth doing alongside the Wave-1 frontmatter chore-fix.

## Multi-agent specific reliability concerns (no human in the loop)

For each scenario below: the agent gets an *output* that looks normal. Only the audit log proves anything went wrong.

| Scenario | Symptom the agent sees | Symptom in audit | Symptom outside audit | Test today? |
|---|---|---|---|---|
| Subagent's `parent_agent_session_id` missing from MCP SDK meta | Returns rules normally | Validator throws (G3); event might not get appended | None — caller sees a "normal" success | Partial (`audit-schema.test.ts` covers the invariant but not the failure-write path) |
| Subagent A's cache `set` races with Subagent B's `get` | Both get rules | Audit shows both retrievals with same `context_hash` | None | No |
| `ConnectionLimiter` 429 returned to one of 20 fan-out subagents | That subagent gets a 429 envelope | No audit event (limiter rejects before retrieve fires) | Subagent might silently proceed without rules | No |
| `JsonlAuditWriter` disk-full mid-batch | Tools return normally | Some events drop; downstream review loses visibility | None | No |
| Agent retrieves but never calls `check_file` (M2) | Agent gets rules, ignores them | `missed_retrieval` fires (if G2 lands)... | ...not until Item 2.5 closes the loop end-to-end | No |
| Corpus rule file modified between cache-hit-time and audit-emit-time | Stale rule returned from cache | No drift signal in audit | None | No (G6) |
| Rule frontmatter invalid → rule silently dropped from corpus | Agent gets fewer rules than it should | No "rule dropped" audit event (only a stdout log) | None | No (G12) |

**Pattern**: every row's "symptom outside audit" column is empty. The audit log is the only signal. If it gaps, the whole story gaps.

## Recommended test additions — ordered by reliability ROI

| Rank | Gap | Effort | Why this rank |
|---|---|---|---|
| 1 | **G1 ConnectionLimiter** | 1d | Multi-agent fan-out is the v1.5 happy path; the limiter is the only thing standing between fleet and failure |
| 2 | **G2 MissedRetrievalDetector** | 0.5d | Item 3 (applied-rule contract) reuses this; cheap to land before Item 3 |
| 3 | **G4 bearerMiddleware adversarial** | 1d | Security boundary; likely surfaces bugs; cheap once written |
| 4 | **G3 JsonlAuditWriter IO failures** | 1d | The single observability surface — gaps here gap the whole reliability story |
| 5 | **G5-M1 search-returns-nothing** | 0.5d | Most likely M1-M5 mode to fire in dogfooding |
| 6 | **G7 OrchestratorRetriever** | 1d | Audit-shape regressions silently break downstream |
| 7 | **G8 DomainRouter + grep** | 1.5d | The actual ranking logic; subtle and untested |
| 8 | **G6 CorpusReader concurrency** | 0.5d | Documents the contract more than fixes bugs |
| 9 | **G9 CLI verbs (especially `gate`)** | 2-3d | `gate --start` needs tests before Phase 4 dogfooding |
| 10 | **G12 Rule frontmatter robustness** | 0.5d | Pair with Wave-1 frontmatter chore-fix |
| (gated) | G10 /mcp dispatcher | 1d | Wait for SDK transport |
| (gated) | G11 multi-agent E2E | 2d | Wait for G10 |
| (gated) | G5-M3/M4/M5 | 4-6d | Wait for Item 2.5 + Item 3 + `RetrievalTransport` |

**Total Tier 1 effort to close**: ~4 days of focused work.
**Total Tier 2 effort**: ~6 days.
**Total ungated work to close all Tier 1 + 2 reliability gaps**: ~10 days = 2 weeks of one-track focused work, or 1 week alongside Item 1b/2.

## Mapping to v1.5 plan

- **Item 1b** (`src/contracts/` Zod extraction) closes class 4 (cross-wave drift) preventatively. Independent of this doc.
- **Item 2** (minimal retrieval tracing) extends the audit schema. Add G7 OrchestratorRetriever tests when the new fields land — same test file, same patterns.
- **Item 2.5** (`report_rule_application` + Stop hook) closes G5-M2 (the M2 closing-the-loop work).
- **Item 3** (applied-rule contract) leans on G2. Land G2 first; Item 3 inherits the test infrastructure.
- **Item 4** (5-day dogfooding gate) needs G9 (specifically `gate --start/--status`) before launch.
- **Item 6** (top-5 rule rewrites) closes G12 if Wave-1 frontmatter is in the top-5.

## Anti-recommendations (don't do these)

- **Don't write tests for 100% coverage**. The CLI verbs that just print pre-formatted reports (`status`, `why`) get a single happy-path smoke; aim for behavior coverage, not line coverage.
- **Don't mock the filesystem in audit writer tests**. Use real tmpdirs. The whole point is to catch IO failures; mocked IO catches nothing.
- **Don't test the MCP SDK**. Test BetterAI's *contract* with the SDK, not the SDK's internals.
- **Don't add a test for every "what if?" you can imagine**. Apply this rule: if the failure mode would fire silently in production with no human signal → write the test. If it would crash loudly → trust the crash.

## Skill / corpus implications

The reliability emphasis here surfaces a corpus gap: there's no rule that fires when an agent adds a new server module without a test. The existing rules (`no-god-files`, `simplicity-first`, etc.) focus on code shape, not test-coverage discipline.

Candidate new rule for the corpus (v1.5 Item 6 or later): `STANDARDS/maintainability/server-modules-have-reliability-tests.md` with `applies_when.paths: ["src/server/**/*.ts"]` and `applies_when.intents: ["new module", "scaffold", "refactor", "extend"]`. The rule's body would reference this document by path.

That rule firing on the *next* server module added would close G1-G8 prospectively rather than chasing them.
