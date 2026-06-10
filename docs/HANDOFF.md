# BetterAI — Handoff (2026-06-10, post-Wave-6)

> Supersedes the 2026-06-09 post-Wave-5 handoff. If you put this down for a week and came back, this doc is the single page that gets you executing again.

---

## Wave 6 — DONE (2026-06-10, this session)

`npm run typecheck` ✅ 0 errors. `npm test` ✅ **198 passed + 1 opt-in skipped** (was 66). Executed as 4 Workflow-orchestrated waves of parallel worktree specialists + 1 hotfix specialist, green gate between every merge.

| Wave | What landed | Key commits |
|---|---|---|
| **0** | SDK pinned ^1.29.0; @hono/node-server + zod declared | `1a4f032` |
| **0.5** | `verify-uncertain-facts` corpus rule (encodes "web-search facts / ask on scope, never guess"); office-hours skill fix proposal at `docs/proposals/office-hours-skill-fix.md` (agent permission-blocked from `~/.claude/skills/*`) | `275b7df`, `b2a0c37` |
| **1** | **`/mcp` placeholder GONE**: SDK 1.29 `WebStandardStreamableHTTPServerTransport`, per-session stateful `McpServer` pairs (mcp-session-id, GET=SSE stream, DELETE=close, idle GC); fixed silent-registration bug (low-level `Server.tool()` probe meant ALL 7 tools were never registered); limiter wraps POST only; `src/contracts/` (audit/retrieval/tool/env + typecheck-time drift guards); SDK-client e2e suite | `479f497`, `1bc87f4` |
| **2** | G4: bearer hosts env-driven via `allowedHostsFromEnv` (port-27777 regression pinned by live-boot test), timingSafeEqual, typed BAI-101/102 errors, 24 adversarial tests; G1: 10 limiter tests (storm N=100); G2: 12 missed-retrieval tests + **real bug fixed** (GC fired FALSE misses when recencyMs > 5min); G3: typed `AuditIoError`, EISDIR/EACCES/rotation/concurrency hardening; G5-M1: structured `{match:"none", reason:"no_match"}` | `db0215a`, `4f43fbf`, `032b21a` |
| **3** | MiniLM hybrid retrieval behind `RetrievalScorer` seam (lazy load, content-hash embedding cache, grep fallback on model failure, opt-in real-model test via `BETTERAI_TEST_EMBEDDINGS=1`); **root cause of the "18 frontmatter issues": 3 bugs in the hand-rolled YAML parser** — corpus files were valid all along; seed corpus now loads 13 rules + 5 skills + 5 memories with 0 issues | `aedd045`, `809c3a3` |
| **4** | `betterai gate --start/--status/--abort` (14 tests); G7 orchestrator tests + **2 real bugs fixed** (`cache_hit` audit field never set; null repoDetector crash) | `470dab4`, `e439961` |
| **5 (hotfix)** | **Live verification caught the cycle's biggest bug**: all retrieval tools used the global-only singleton `CorpusReader` — repo rules were unreachable while audit claimed `scopes_queried: ["global","repo"]`. All 6 tools rewired to `RetrievalOrchestrator` (+ scoped reader for check-file); honesty regression test added (scopes_queried only includes "repo" when readable) | `1bf6c58` |

### Cycle-end verification (PASSED, evidence in `~/.betterai-verify/audit.jsonl`)

Real SDK MCP client over HTTP: two sessions (main + researcher subagent) sharing `parent_agent_session_id`, distinct `agent_session_id`s, `subagent_class` threaded, **4 rules returned mixing global + repo scope** (incl. `verify-uncertain-facts:repo`), `cache_hit: true` on the second call, `match: "matched"` discriminant. `gate --start/--status/--abort` exercised live (checklist all OK, projection + proxy note render, abort archives).

### Wave-6 follow-ups (tracked, not blockers)

- **Router mini-YAML parser ignores flat top-level keys** (`router.ts`) — `domain-router.yaml` silently falls back to built-in default domains `["maintainability","methodology"]`. Swap in the `yaml` package (existing TODO) and add G8 router tests.
- `record_memory` still uses stateless `detectRepoRoot`; can create `.betterai/` where none exists when `scope:"repo"` forced.
- `ToolContext.corpusReader` singleton now unused by tools; drop in a contract cleanup.
- Embeddings in Docker: bake the MiniLM model via `BETTERAI_MODEL_CACHE_DIR` (first hybrid score downloads ~25MB otherwise; offline degrades cleanly to grep).
- Apply `docs/proposals/office-hours-skill-fix.md` to `~/.claude/skills/office-hours/SKILL.md` manually (user action).

### The next actions (post-Wave-6, in order)

1. **Start Item 4 dogfooding**: `betterai gate --start` for real (5 days × ≥5 fires × ≥3 behavior changes). The full pipeline is now live and observable.
2. v1.5 Item 2.5: `report_rule_application` tool + Stop hook (turns the gate's behavior-change proxy into real `apply_compliance` events).
3. Fix the router YAML parser + G8 tests; then retrieval-quality tuning (Items 5a/5b/6) — note routing currently runs on default domains.
4. Website-build eval (per EVAL-HARNESS.md): portfolio + repo architecture map, control vs corpus-loaded agent, HITL judging — user decision: run now that /mcp is wired.
>
> **Companion doc**: [`docs/RELIABILITY-TEST-GAPS.md`](RELIABILITY-TEST-GAPS.md) — test gap analysis ranked by reliability ROI; agents are hard to monitor with human-in-the-loop, so the audit log is the only observability surface and the gaps in it are the gaps in BetterAI's reliability story.

---

## What BetterAI is (the one-paragraph elevator)

A **Dockerized rule corpus + MCP retrieval service** that injects relevant code-quality / design / maintainability rules into any AI agent&rsquo;s context **before** the agent writes or plans code. Two corpus scopes — **global** (`~/.betterai/`) and **repo** (`<repo-root>/.betterai/`) with repo-wins id-collision override. The agent retrieves rules + skills + memories via `retrieve_context` (canonical MCP entry point). VSCode is the human surface. Personal toolkit, not a product. The corpus is the moat. No runtime dependency on Aether, Aide, GBrain, or techdebt.

---

## Where everything lives (current repo state)

| Artifact | Path | State |
|---|---|---|
| **v4 design (APPROVED)** | `docs/design/v4-design.md` | source of truth (vendored into repo) |
| **v4.1 scoping extension (LOCKED)** | `docs/design/v4.1-scoping-extension.md` | repo-scoped knowledge bases |
| **Corpus eng review** | `docs/reviews/corpus-migration-eng-review.md` | schema locked, 11 issues addressed |
| **Multi-agent eng review** | `docs/reviews/multi-agent-evals-eng-review.md` | skills + memories + auto-retrieve |
| **DX review** | `docs/reviews/devex-review.md` | TTHW 5-12min &rarr; 2-4min path |
| **Implementation roadmap (HTML)** | `docs/IMPLEMENTATION-ROADMAP.html` | phases + fleet + 40-TODO matrix |
| **Component docs** (10 HTMLs) | `docs/components/*.html` | per-component Security/Robustness/Tech Debt/Decisions/Tradeoffs/Status |
| **Component docs index** | `docs/components/index.html` | system overview + cross-cutting concerns |
| **Auto-stamp harness** | `scripts/update-component-docs.mjs` + `.githooks/pre-commit` | per-commit "Recent commits" stamping in component HTMLs |
| **Global corpus seed (source for image)** | `rules/`, `skills/`, `memories/`, `rules/_meta/` | 26 files (13 rules + 5 skills + 5 memories + 3 meta) |
| **BetterAI repo-specific corpus** | `.betterai/rules/STANDARDS/{security,observability,maintainability}/` | 5 rules that govern BetterAI itself |
| **TS server source** | `src/server/{main,transport,auth,retrieve,cache,audit,scope,corpus}/*.ts` | 12 files / 2,590 LOC |
| **7 MCP tools** | `src/mcp-tools/{retrieve-context,rules,skills,memories,record-memory,explain-rule,check-file}.ts` | <span style="color:#d29922">authored, do not yet compile (contract drift)</span> |
| **CLI** (7 verbs) | `src/cli/{main,init,validate,status,why,replay,gate,new}.ts` + `_shared/` + `bin/betterai` | 12 files |
| **Tests + validator** | `src/__tests__/` (6) + `src/_meta-validators/` (2) | 35-test validator suite + 6 integration tests |
| **User docs** | `README.md`, `docs/AUTHORING.md`, `docs/DEBUGGING.md` | 3 docs |
| **Build infra** | `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.nvmrc`, `install.sh`, `seed-corpus/welcome-task/` | scaffold complete |
| **RULES.md** | `RULES.md` | historical draft; superseded by `rules/` |

**Older artifacts (kept as historical refs in `~/.gstack/projects/betterai/`):**
- v1/v2/v3 designs from 2026-06-08 (reference only; superseded by v4)
- Prior `HANDOFF-20260609-151359.md` (this doc supersedes it)

---

## The locked schema (don&rsquo;t re-litigate)

Same as prior handoff for the rule frontmatter, PLUS:

**Two corpus roots (v4.1):**
- Global: `~/.betterai/{rules,skills,memories,_meta}/` (image-baked seed; copied on first run)
- Repo: `<repo-root>/.betterai/{rules,skills,memories}/` (per-project, version-controlled)
- Scope is **implicit from corpus root** — no `scope:` field in frontmatter.
- ID-collision: **repo wins**; global dropped from response; `overridden_global_ids` in audit.

**Three artifact kinds (multi-agent eng review):**
- **Rules** = constraints (DON&rsquo;T do X). Human-curated.
- **Skills** = procedures (HOW to do Y). Human or codified-from-flow.
- **Memories** = episodes (LAST time we tried Z). Date-sharded `yyyy-mm/`. Agent-writable via `record_memory`.

**Audit schema additions (multi-agent + v4.1):**
- `parent_agent_session_id`, `subagent_class`, `retrieved_kinds` (multi-agent)
- `repo_root_detected`, `scopes_queried`, per-item `scope`, `overridden_global_ids` (v4.1)

**Auto-retrieve: 3 levers (multi-agent eng review &sect;1.6):**
- (a) install script writes CLAUDE.md preamble — default-yes
- (b) server-side `missed_retrieval` audit event — automatic
- (c) optional `~/.claude/skills/betterai-auto-retrieve/SKILL.md` — default-no opt-in

---

## Phase map &mdash; current state

| Phase | Scope | Status | Notes |
|---|---|---|---|
| **Phase 0** | Hand-author seed corpus (13 rules + 5 skills + 5 memories) | <span style="color:#3fb950">**DONE**</span> | Wave 1 fleet (7 team leads, 3m 21s) |
| **v4.1 scoping** | Repo-scoping mechanism + BetterAI repo seed | <span style="color:#3fb950">**DONE**</span> | Wave 2 (3 specialists, 3m 58s) |
| **Phase 1.0 scaffold** | TS server + Docker + 7 MCP tools + CLI + tests + docs | <span style="color:#d29922">**SCAFFOLDED, doesn&rsquo;t compile**</span> | Wave 3 (5 team leads, 10m 45s, 7.2k LOC). 247 typecheck errors; 51/66 tests pass. |
| **Phase 1.0 compile/test green** | Cross-team contract reconciliation; relax tsconfig OR strictness sweep | <span style="color:#3fb950">**DONE**</span> | Wave 5 (2026-06-09): 0 typecheck errors, 66/66 tests. `/mcp` HTTP dispatch still placeholder — wire SDK transport before Item 2.5. |
| **Phase 1.0 dogfooding gate** | 5 consecutive engineering days &times; &ge;5 rule fires &times; &ge;3 behavior changes | not started | Blocked by compile-green |
| **Phase 1.5** | Embeddings + ast-grep + multi-arch + install polish | not started | Blocked by dogfooding gate |
| **Phase 2** | VSCode extension | not started | Blocked by Phase 1.0 dogfooding |
| **Phase 3** | Eval lift harness (optional) | not started | Optional; trigger when you want a lift number |
| **Phase 4** | v2 (sandboxed exec, remote MCP, self-learning, Marketplace) | speculative | months out |

---

## What happened this session (4 waves of orchestration)

| Wave | Phase covered | Agents | Output | Wall clock |
|---|---|---|---|---|
| **1** | Phase 0 corpus seed | 7 team leads (parallel worktrees) | 26 files: rules + skills + memories + _meta | 3m 21s |
| **2** | v4.1 scoping extension | 3 specialists (design / meta updates / BetterAI repo seed) | 9 files: design doc + 2 _meta rewrites + 5 BetterAI repo rules + README | 3m 58s |
| **3** | Phase 1.0 scaffold | 5 team leads (build / server / tools / cli / tests) | 51 files: 7.2k LOC TS + Docker + install.sh + welcome task + 3 user docs | 10m 45s |
| **4** | Test + typecheck (parallel to docs work) | 1 testing specialist | report: 51/66 tests passing, 247 typecheck errors, 3 critical findings | 4m 44s |

Plus the orchestrator (you / Claude main loop) personally authored:
- 10 per-component HTML docs (`docs/components/*.html`)
- The auto-stamp harness (`scripts/update-component-docs.mjs` + `.githooks/pre-commit`)
- This handoff

**Cumulative:** 84+ files / 9 commits on main / 4 review documents / 1 implementation roadmap / 1 docs harness.

---

## Wave 5 — DONE (2026-06-09, this session)

`npm run typecheck` ✅ **0 errors** (was 247). `npm test` ✅ **66/66 passing** (was 51/66, 77%).

### What landed

- **Phase 0**: pre-flight chore commit (`c4d5502`) — @types/node bump, package-lock regen, gate.ts type annotation, Datadog static-analysis config.
- **Specialist X** (`16c765f`, merged at `33fb1f3`): `src/server/scope/detect.ts` (`detectRepoRoot()` wrapper); 5 view methods on `CorpusReader` (`fetchRules/fetchSkills/fetchMemories/fetchRuleById/fetchCheckableRules`); `ContextCache.keyFor()`; lazy `JsonlAuditWriter.mkdirSync`; `AuditEvent.cache_hit?: boolean`; barrel `src/server/cache/index.ts` + `createContextCache()` factory.
- **Specialist Y** (`18c9b3d`, merged at `66a8ad2`): rewrote all 7 `src/mcp-tools/*.ts` to use reconciled API + `ToolCallMeta` 3rd-arg pattern; wired `src/index.ts` to import + register 7 tools via `startServer({tools: [...]})`; relaxed 3 strictness flags; mapped 71 sites in `TODO-strictness-sweep.md`; recovered Wave 4's "already fixed" diff losses (`_filepath`, `readFileSync`, `AppliesWhenT`).
- **Post-merge gate finalization** (`68362dc`): `src/server/retrieve/index.ts` cache-hit `Rule[] → AuditEventRuleEntry[]` mapping; rewrote `retrieve-context.test.ts` + `server-boot.test.ts` fixtures to the reconciled API; added programmatic `validate()` export to `src/cli/validate.ts` for `cli-offline.test.ts`.

### Harness verification (in-process, this session)

- Server boots via `startServer({tools: 7, env: {...}})` on `127.0.0.1:7777` with the seed corpus.
- `GET /health` returns 200 (bearer bypass works); `auth.bypass` audit event emitted with full envelope (`{event_type: "explain", subagent_class: "main", parent_agent_session_id: null, tool_call_id: "auth.bypass", rules_returned: [{reason: "path=/health ip=... ua=..."}], ...}`).
- 18 pre-existing rule frontmatter issues logged at corpus-load — Wave 1 seed needs to fix `applies_when.paths`/`applies_when.intents` shapes (string/null where array expected). Not Wave 5; tracked separately.
- In-process tool dispatch fully proven by tests: `retrieve-context.test.ts` exercises the real `ToolContext`/`ToolCallMeta`/`CachedRetrieval` envelope path end-to-end.

### Known follow-on (NOT in Wave 5 scope)

- **`POST /mcp` HTTP dispatch is a v1.0 placeholder.** The handler returns `{error: "mcp_dispatch_unimplemented", detail: "Phase 1.0 placeholder — wire SDK's StreamableHttpServerTransport when it lands"}`. End-to-end MCP-over-HTTP cannot be verified until this is wired. The MCP SDK's streamable HTTP transport API was stabilizing at Wave 3 write-time — re-check the SDK now and finish the wiring. **Pre-req for Phase 4/5 of the original Wave 5 plan and for Item 2.5's `report_rule_application` flow.**
- **Hardcoded `127.0.0.1:7777` / `localhost:7777` in `bearer.ts:32-36` allowedHosts list.** Surfaced in this session as a real harness blocker (port 27777 was rejected). Per the new corpus rule `.betterai/rules/STANDARDS/maintainability/config-from-env-not-hardcoded.md`, this should be env-driven (`BETTERAI_BIND_HOST`:`BETTERAI_MCP_PORT` already exist on the env schema). One-line fix; deferred to a chore commit.
- **18 rule frontmatter shape issues** in the Wave-1 seed corpus (`applies_when.paths`/`intents` typed wrong). Track as a Wave 1.x chore.
- **MCP transport completion → orchestration verification.** Once `/mcp` dispatch works, run Phase 5 of the original plan (subagent dispatch via Agent tool → audit shows two events sharing `parent_agent_session_id`; missed_retrieval fires; cache key isolation across `repo_root_detected`).

---

## Wave 4 findings (the single most important read before Wave 5)

`npm install` ✅ ok (7.3s). `npm test` ⚠️ **51/66 passing (77%)**. `npm run typecheck` ❌ **247 errors**.

### 3 critical findings (block Phase 1.0)

1. **Team C MCP tools reference fictional ToolContext API.** All 7 tools call `ctx.cache.keyFor()`, `ctx.corpusReader.fetchRules/Skills/Memories()`, `ctx.session`, `ctx.toolCallId`, `AuditEvent.cache_hit`, `Rule.score/reason`. None exist on Team B&rsquo;s actual contracts. Blocks every MCP tool from compiling and all 4 `retrieve-context.test.ts` tests fail with `TypeError: ctx.cache.keyFor is not a function`. <span style="color:#f85149">**P0 Wave 5.**</span>

2. **scope detection contract mismatch.** Tests + tools call `detectRepoRoot(paths)` from `src/server/scope/detect.ts`; Team B shipped `class RepoDetector` with `detect()/detectFromBatch()` in `src/server/scope/repo-detector.ts`. File name + export shape both differ. 3 `scope-detection.test.ts` tests fail; indirectly blocks all retrieve tests. <span style="color:#f85149">**P0 Wave 5.**</span>

3. **`src/index.ts` calls `startServer()` with no args** but signature requires `{ tools: McpTool[] }`. Even if tools compiled, the entrypoint doesn&rsquo;t register them. <span style="color:#d29922">**P1 Wave 5.**</span>

### Strictness fallout (165+ of the 247 errors)

`tsconfig.json` is &ldquo;strict-everything&rdquo; including `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Generates 165+ stylistic errors with no behavioral bugs in 24 files (CLI verbs, the rule-schema validator, the router, the corpus reader). **Decision needed in Wave 5:** relax these 3 flags for Phase 1.0 (likely correct) OR 1-2 day systematic strictness sweep.

### Medium issues to address in Wave 5

- `JsonlAuditWriter` mkdirs `/data/audit` at construction time; `server-boot.test.ts` can&rsquo;t write there in test env. Lazy-init or DI the audit path.
- `cache.test.ts` &ldquo;evicts the least-recently-used entry&rdquo; fails — LRU eviction semantics off.
- `cli-offline.test.ts` (3 tests) fails at exec time; likely tsx/CJS path or missing build step.
- `ContextCache.get<T>()` returns `CachedRetrieval<T>` envelope, not raw arrays — tools must respect the envelope.
- `DomainRouter` uses index-signature dot access in `router.ts:210-211` — part of the strictness fallout.

### Wave 4 already fixed (small)

- Removed unused `AppliesWhenT` import from `grep.ts`.
- Removed unused `readFileSync` import from `init.ts`.
- Renamed unused `filepath` params to `_filepath` in `rule-schema.ts`.

---

## The immediate next 3 actions (in order, post-Wave-5)

### 1. Wire the MCP SDK's streamable HTTP transport into `/mcp`

`src/server/transport/http-sse.ts` `/mcp` currently returns `{error: "mcp_dispatch_unimplemented"}`. Until this lands:
- No real MCP client can call any tool — only in-process unit tests exercise the contract.
- Phase 4/5 of the original Wave 5 plan (multi-agent orchestration verification over HTTP) is blocked.
- Item 2.5's `report_rule_application` Stop hook can't flow because the Stop hook calls the MCP tool over HTTP.

What changed since Wave 3 wrote the placeholder: the MCP SDK's HTTP transport API was "stabilizing." Re-check the SDK now, choose between `StreamableHttpServerTransport` and the SSE alternative, and replace the placeholder. Expected ~1 day. Once green: re-run the harness verification from the Wave 5 plan (Phase 4 + 5).

### 2. Close Tier 1 reliability test gaps

Per [`docs/RELIABILITY-TEST-GAPS.md`](RELIABILITY-TEST-GAPS.md), 5 critical reliability primitives ship with zero or partial test coverage:

- **G1 ConnectionLimiter** — multi-agent fan-out's only protection. 0 tests. ~1d.
- **G2 MissedRetrievalDetector** — the v1.0 compliance-detection mechanism. 0 tests. ~0.5d.
- **G3 JsonlAuditWriter IO failures** — the single observability surface. ~1d.
- **G4 bearerMiddleware adversarial inputs** — happy path only today. ~1d. Will surface real bugs.
- **G5-M1 search-returns-nothing** — most likely M1-M5 mode to fire in dogfooding. ~0.5d.

Total: ~4 days. Do these before dogfooding (action 3) so gate-day failures don't silently disappear.

### 3. Start Item 4 — the 5-day Phase 1.0 dogfooding gate

5 consecutive engineering days using Claude Code + BetterAI on actual work. Per the v1.5 plan §"Item 4," with the `betterai gate --start/--status/--abort` verbs (which still need to be implemented — they're in the v1.5 plan, not Wave 5). Target: &ge;5 rule fires AND &ge;3 visible behavior changes. Use `betterai gate --week 1` to self-verify against the audit log.

**Pre-requisite for action 3 from the v1.5 plan that is NOT YET BUILT**: `betterai gate --start/--status/--abort` CLI verbs. The existing `betterai gate --week N` exists; the start/status verbs need to be added (Item 4 deliverable per v1.5 plan).

---

## Falsification gates (don&rsquo;t skip)

| Gate | Status | Test |
|---|---|---|
| **Day 1 corpus signal** (23 files materialize, schema-valid, retrievable) | <span style="color:#3fb950">PASSED</span> | Wave 1 + Wave 2 |
| **Phase 1.0 compile gate** (0 typecheck errors, &ge;90% tests pass) | <span style="color:#3fb950">PASSED</span> | Wave 5 (0 errors, 66/66 = 100%) |
| **`/mcp` HTTP dispatch responds to a real MCP client** | <span style="color:#f85149">FAILING</span> | Placeholder; wire SDK transport |
| **Tier 1 reliability tests** (G1-G5 from RELIABILITY-TEST-GAPS.md) | <span style="color:#f85149">FAILING</span> | 4 days of focused work |
| **TTHW &lt; 5 min** on fresh machine (DX gate) | not measured | Run install.sh end-to-end |
| **Phase 1.0 dogfooding** (5 days &times; &ge;5 fires &times; &ge;3 behavior changes) | not started | After compile gate |
| **Multi-agent retrieval rate** (3/3 subagents call retrieve_context in parallel-bug-hunt fixture) | not measured | Phase 3 eval (optional) |

---

## Unresolved decisions (will come up; decide when forced)

1. **tsconfig strictness posture for Phase 1.0.** Recommend RELAX `noPropertyAccessFromIndexSignature` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Revisit at Phase 1.5 when there&rsquo;s time for a systematic sweep. **Auto-decide: relax.**
2. **Import techdebt PATTERNS / STANDARDS content?** Deferred. Auto-decide after Phase 1.0 dogfooding.
3. **Embedding model (MiniLM vs OpenAI):** MiniLM by default; revisit at Phase 1.5 if retrieval quality is the bottleneck.
4. **Conflict-resolution priority order** when memory + rule + skill collide on the same intent. Implemented as: memory(decision/long) &gt; rule &gt; skill, with repo &gt; global at id-collision. Don&rsquo;t revisit unless an actual conflict surprises you.
5. **Phase 3 eval timing.** Optional; trigger when you want a hard lift number.
6. **`record_memory` from any subagent class.** v1 allows all; future-self can restrict if memory pollution becomes a problem.

---

## What NOT to do (lessons preserved from prior handoff + new ones)

- **Don&rsquo;t build a custom IDE workbench.** v3 designed Theia AI; rejected. Stay with VSCode extension.
- **Don&rsquo;t depend on Aether / Aide / GBrain / techdebt at the runtime code level.** MCP clients, not code deps.
- **Don&rsquo;t add `check.kind=shell` or `ts-module` to v1.** Sandboxing is v2.
- **Don&rsquo;t ship with `:latest` Docker tag.** SHA-pin via `${BETTERAI_IMAGE_SHA}` in compose.
- **Don&rsquo;t run the container as root.** `user: "${UID}:${GID}"` mandatory.
- **Don&rsquo;t expose MCP on localhost without a bearer token.**
- **Don&rsquo;t write rules as &ldquo;prose with embedded code blocks&rdquo;.** Per-file schema only.
- **Don&rsquo;t conflate categories with domains.** Category is human; domain is router.
- **NEW: Don&rsquo;t re-introduce stdio MCP transport.** HTTP/SSE only. `.betterai/rules/STANDARDS/maintainability/no-stdio-mcp-transport.md` enforces this.
- **NEW: Don&rsquo;t skip the bearer check on any tool.** `.betterai/rules/STANDARDS/security/mcp-tools-require-bearer.md`.
- **NEW: Don&rsquo;t emit audit events with `subagent_class != main` and null `parent_agent_session_id`.** Validator throws.
- **NEW: Don&rsquo;t omit scope + repo_root from the context_hash cache key.** Cross-scope cache poisoning.
- **NEW: Don&rsquo;t put auth bypass on any tool other than `/health`.** And `/health` bypass logs the source IP + UA.
- **NEW: Don&rsquo;t parallel-spawn agents without explicit non-overlapping slices.** Wave 3&rsquo;s contract drift came from teams agreeing on shapes in their prompts but each team implementing the agreement differently. The fix is shared TS types in a `src/contracts/` module that ALL teams import — track for the next big fan-out.

---

## How to re-enter context after a break

1. Read this file (you&rsquo;re here).
2. Open `docs/components/index.html` in a browser &mdash; one screen for the whole system.
3. Skim `docs/IMPLEMENTATION-ROADMAP.html` for the phase map.
4. Read `docs/reviews/devex-review.md` &sect;Current status if you want the score.
5. Run `git log --oneline | head -10` to see the wave commits.
6. Run `npm install && npm run typecheck 2>&1 | head -30` to confirm the current state (247 errors expected until Wave 5).
7. Run `npm test 2>&1 | tail -20` to confirm 51/66 passing.
8. Open `docs/components/mcp-tools.html` and `docs/components/scope.html` for the P0 contract drift detail.
9. If pursuing Wave 5: read &sect;1 above ("Run Wave 5 &mdash; contract reconciliation"). Two specialists in parallel worktrees.

---

## Active reviews / open work

| Item | State | Owner | Next action |
|---|---|---|---|
| v4 design | APPROVED | you | implementation Phase 1.0 |
| v4.1 scoping extension | LOCKED | you | implementation alongside Phase 1.0 |
| Corpus migration eng review | COMPLETE | you | implemented via Wave 1 |
| Multi-agent eng review | COMPLETE | you | implemented via Waves 1+2; auto-retrieve a+b+c still need Phase 1.0 server work |
| DX review | COMPLETE | you | install.sh + welcome task in scaffold (Wave 3) |
| Phase 1.0 scaffold | SHIPPED, won&rsquo;t compile | you | Wave 5 contract reconciliation |
| Component docs + harness | LIVE | you | auto-stamps per commit |
| VSCode extension | spec&rsquo;d, not built | you | Phase 2 after Phase 1.0 dogfooding |
| Eval lift harness | optional | you | Phase 3 if you want a number |

---

## Cumulative TODOs (40 items across series; consolidate when TODOS.md is created)

| Series | Items | Phase | Status |
|---|---|---|---|
| **TD-R** (corpus migration) | TD-R1..TD-R9 | Phase 0 | Mostly satisfied by Wave 1; TD-R5 (retrieval fixtures), TD-R6 (conflict-resolution doc) done; TD-R9 (techdebt import) deferred |
| **TD-M** (multi-agent + skills/memories) | TD-M1..TD-M13 | Phase 0 + Phase 1.0 server | TD-M1..M6 satisfied by Wave 3 scaffold (modulo contract drift); TD-M7 (lever a) in install.sh; TD-M8 (lever b) in `audit/missed-retrieval.ts`; TD-M10..M11 (eval fixtures) not started |
| **TD-D** (DX) | TD-D1..TD-D9 | Phase 1.0 + Phase 2 | TD-D1 (welcome task), TD-D2 (install.sh), TD-D4 (CLI verbs), TD-D5 (scaffolder) shipped in Wave 3; TD-D6 (error code taxonomy), TD-D8 (`betterai upgrade`) not started |
| **TD-S** (scoping) | TD-S1..TD-S9 | alongside Phase 1.0 | Mostly satisfied by Wave 2 + Wave 3 scope module; tests still need contract fixes |
| **NEW** (post-Wave-4) | Wave 5 contract reconciliation | Phase 1.0 compile gate | <span style="color:#f85149">P0</span> |

---

## Status

**DONE:** four design iterations × three adversarial reviews + one approved design + v4.1 scoping extension; 23 seed corpus files + 5 BetterAI repo rules + 3 _meta docs; 51-file Phase 1.0 scaffold; 10 component HTML docs; auto-stamp harness; **Wave 5 contract reconciliation (typecheck 0 + 66/66 tests)**; v1.5 plan approved with Codex's 6-item cut; 3 new corpus rules from session code-review; eval harness design (`docs/EVAL-HARNESS.md`); reliability test gap analysis (`docs/RELIABILITY-TEST-GAPS.md`); 17 commits on main.

**NOT YET DONE (updated post-Wave-6):** install.sh end-to-end run; Phase 1.0 dogfooding gate (verbs now exist — run it); Items 2/2.5/3/5/6 of the v1.5 plan; router YAML parser fix + G8 tests; ast-grep; VSCode extension; eval lift harness implementation; website-build eval.

> Superseded by Wave 6 (see §"Wave 6 — DONE" at top): `/mcp` transport ✅, contracts (Item 1b) ✅, gate verbs (Item 4 tooling) ✅, Tier-1 G1-G5 ✅, embeddings (hybrid) ✅, Phase 4/5 harness verification ✅.

**The single next action:** Run the 5-day dogfooding gate for real: `betterai gate --start`, use BetterAI from Claude Code on daily work, `betterai gate --status` to track. In parallel, Item 2.5 (`report_rule_application` + Stop hook) turns the gate's behavior-change proxy into real `apply_compliance` measurements.

---

## End-of-session handoff notes (2026-06-09 evening)

This session touched four threads in order:

1. **Strategy (office-hours + autoplan)**: Pivoted v1.5 plan from "Two-Track Parallel, 9 items, 7-9 weeks" to "Codex's 6-item dogfooding-proof cut, 5-6 weeks linear" after both /autoplan voices flagged 6/6 CEO dimensions. The design doc is at [`~/.gstack/projects/betterai/nicov-main-design-20260609-170602.md`](../../.gstack/projects/betterai/nicov-main-design-20260609-170602.md) (path is outside the repo; vendored only as needed). Eval harness sub-design: [`docs/EVAL-HARNESS.md`](EVAL-HARNESS.md).

2. **Corpus additions**: 3 new rules under `.betterai/rules/STANDARDS/` — `config-from-env-not-hardcoded`, `typed-errors-from-errors-layer`, `no-magic-numbers-import-from-constants`. Authored after a code review of `src/server/auth/bearer.ts` + `src/server/cache/context-hash.ts` surfaced 8 architectural smells the existing `layered-architecture-default` rule should have caught but didn't (its `applies_when.intents` triggers are too narrow — tracked for v1.5 Item 6 sweep).

3. **Wave 5 execution**: 7 commits landed on main:
   - `c4d5502` pre-flight chore
   - `16c765f` + `33fb1f3` Specialist X (server contracts)
   - `18c9b3d` + `66a8ad2` Specialist Y (tools + entrypoint + tsconfig)
   - `68362dc` post-merge gate finalization
   - `b2bf8e3` HANDOFF v1
   - `e196d4c` corpus + EVAL-HARNESS doc

   Result: typecheck 0, tests 66/66, harness boot verified in-process. `/mcp` HTTP dispatch is a known placeholder.

4. **Reliability gap analysis**: [`docs/RELIABILITY-TEST-GAPS.md`](RELIABILITY-TEST-GAPS.md) — 12 gaps ranked by ROI. Reliability matters here because agents are hard to monitor with a human in the loop; the audit log is the only observability surface and gaps in it gap the whole story.

### Hot-bug list (real bugs found, not yet fixed)

- **Hardcoded `127.0.0.1:7777` allowedHosts in `bearer.ts:32-36`** — surfaced when this session's harness verification tried port 27777 and got `host_not_allowed`. The `config-from-env-not-hardcoded` corpus rule warns about exactly this. One-line env-driven fix. Tracked.
- **18 rule frontmatter shape issues in the Wave-1 seed corpus** — `applies_when.paths` or `applies_when.intents` are string/null where array is expected. Server logs at corpus-load and proceeds. Tracked for a Wave-1 chore.
- **`/mcp` HTTP dispatcher is `mcp_dispatch_unimplemented`** — known placeholder from Wave 3, gates Item 2.5 + Phase 4/5 verification.
- **Reliability primitives without tests** — G1 ConnectionLimiter, G2 MissedRetrievalDetector, G3 JsonlAuditWriter IO failures, G4 bearerMiddleware adversarial, G5 M1-M5 fault tolerance. See `docs/RELIABILITY-TEST-GAPS.md` for the full inventory.

### What I'd do first if I sat down tomorrow

A single track, in order:

1. (~1d) Wire `/mcp` SDK transport. Validate via Claude Code calling `retrieve_context` for real.
2. (~1d) Fix `bearer.ts` allowedHosts to use env (`BETTERAI_BIND_HOST` + `BETTERAI_MCP_PORT` already exist on the env schema). Add adversarial bearer tests (G4) while you're in there.
3. (~1d) Add tests for `ConnectionLimiter` (G1) and `MissedRetrievalDetector` (G2). Both small, both high-ROI, both block Item 3 cleanly.
4. (~0.5d) Fix the 18 Wave-1 frontmatter issues + add G12 robustness tests.
5. (~2-3d) Implement Item 4's `betterai gate --start/--status/--abort` verbs.
6. (1 week) Run the dogfooding gate.

That sequence closes the reliability story before the dogfooding gate measures behavior on top of it. Without G1-G5, the dogfooding metric is "what BetterAI did when it didn't silently fail" — measurement on top of a noisy floor.
