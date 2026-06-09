# BetterAI — Handoff (2026-06-09, end of orchestration session)

> Supersedes `HANDOFF-20260609-151359.md`. If you put this down for a week and came back, this doc is the single page that gets you executing again.

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
| **Phase 1.0 compile/test green** | Cross-team contract reconciliation; relax tsconfig OR strictness sweep | <span style="color:#f85149">**NEXT (Wave 5)**</span> | 3 critical contract issues; 1-2 day fix |
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

## The immediate next 3 actions (in order)

### 1. Run Wave 5 &mdash; contract reconciliation

Spawn 2 specialists in parallel worktrees:

**Specialist X (Team B side):**
- Add `src/server/scope/detect.ts` with `export function detectRepoRoot(paths: string[]): string | null` as a thin wrapper around `class RepoDetector`. Keep the class; add the function.
- Extend `CorpusReader` with `fetchRules() / fetchSkills() / fetchMemories()` view methods OR change the tools to use `read()`-returned `CorpusSnapshot`. Pick one and align.
- Add `keyFor(input)` method to `ContextCache` OR have tools call `contextHash()` directly.
- Add `cache_hit: boolean` to `AuditEvent` shape if the tools genuinely need it (else delete from tool calls).
- Add `session?: string` and `tool_call_id?: string` to `ToolContext` (sourced from the 3rd `meta` arg the MCP SDK passes).
- Move `JsonlAuditWriter` mkdir to first-append (lazy) OR accept an `audit_path` override.

**Specialist Y (Team C side):**
- Rewrite all 7 `src/mcp-tools/*.ts` to use the reconciled API.
- Wire `src/index.ts` to `import` all 7 tools and pass `{ tools: [...] }` to `startServer()`.
- Decide tsconfig posture: recommend RELAX `noPropertyAccessFromIndexSignature` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` for Phase 1.0 (165+ errors disappear with no behavioral risk). Document the relaxation in a CLAUDE.md or `docs/AUTHORING.md` note for future-Nico to revisit at Phase 1.5.
- Fix the LRU eviction case in `cache/context-hash.ts` (the `cache.test.ts` failure).

**Gate:** `npm run typecheck` returns 0 errors; `npm test` passes &ge;90% (60/66). The handoff doc updated to reflect green.

### 2. Run install.sh end-to-end manually

Once compile-green:
- `npm run build && docker build -t betterai/server:dev . && docker compose up -d`
- Verify `/health` returns 200.
- Verify Claude Code MCP discovery sees `betterai` tools.
- Hit `retrieve_context` from Claude Code on a real prompt.
- Tail `~/.betterai/audit/audit.jsonl` to confirm the event shape (parent_session_id, scopes_queried, scope per item).

### 3. Start the Phase 1.0 dogfooding gate

5 consecutive engineering days using Claude Code + BetterAI on actual work. Target: &ge;5 rules fire across the week AND &ge;3 visible behavior changes (qualitative). Use `betterai gate --week 1` to self-verify against the audit log.

---

## Falsification gates (don&rsquo;t skip)

| Gate | Status | Test |
|---|---|---|
| **Day 1 corpus signal** (23 files materialize, schema-valid, retrievable) | <span style="color:#3fb950">PASSED</span> | Wave 1 + Wave 2 |
| **Phase 1.0 compile gate** (0 typecheck errors, &ge;90% tests pass) | <span style="color:#f85149">FAILING</span> | Wave 5 = pre-req |
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

**DONE:** four design iterations &times; three adversarial reviews + one approved design + v4.1 scoping extension; 23 seed corpus files + 5 BetterAI repo rules + 3 _meta docs; 51-file Phase 1.0 scaffold; 10 component HTML docs; auto-stamp harness; 9 commits on main; testing report with green path to Phase 1.0 compile.

**NOT YET DONE:** typecheck-green; test-green; install.sh end-to-end run; Phase 1.0 dogfooding gate; embeddings; ast-grep; VSCode extension; eval lift harness.

**The single next action:** Wave 5 &mdash; contract reconciliation. Two specialists in parallel worktrees. Recommended duration: ~3-5 hours of agent work; estimated post-merge gate: 0 typecheck errors + &ge;90% test pass.
