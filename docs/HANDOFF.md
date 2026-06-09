# BetterAI — Handoff (2026-06-09)

> If you put this down for a week and came back, this doc is the single page that gets you executing again.

---

## What BetterAI is (the one-paragraph elevator)

A **Dockerized rule corpus** plus an **MCP retrieval service** that injects relevant code-quality / design / maintainability rules into any AI agent's context **before** the agent writes or plans code. VSCode is the human surface for browsing rules, seeing what was applied, and editing the corpus. Personal toolkit, not a product. The corpus is the moat. Built from scratch, no runtime dependency on Aether, Aide, GBrain, or techdebt.

---

## Where everything lives

| Artifact | Path | State |
|---|---|---|
| **v4 design doc (APPROVED)** | `~/.gstack/projects/betterai/nicov-unknown-design-20260609-141323.md` | source of truth |
| **Eng review (RULES.md → corpus)** | `~/.gstack/projects/betterai/nicov-unknown-eng-review-rules-corpus-20260609-145545.md` | schema locked, 11 issues mapped to fixes, 13 rule files specified |
| **RULES.md draft (source for migration)** | `/Users/nicov/BetterAI/RULES.md` | 558 lines, ~7 nominal rules, needs the migration in §2.2 of the eng review |
| **v3 design (SUPERSEDED — Theia, dropped)** | `~/.gstack/projects/betterai/nicov-unknown-design-20260608-150437.md` | reference only |
| **v2 / v1 designs (historical)** | `~/.gstack/projects/betterai/nicov-unknown-design-20260608-{140809,135005}.md` | reference only |
| **techdebt reference project** | `/Users/nicov/techdebt/` | inspiration for the 5-doc category taxonomy; NOT a runtime dep |
| **target corpus root (doesn't exist yet)** | `~/.betterai/rules/` | created by Phase 1.0 Day 1 |
| **target BetterAI repo (doesn't exist yet)** | `/Users/nicov/BetterAI/` exists but mostly empty; the container scaffold + MCP server live here | scaffold lands in Phase 1.0 |

---

## The locked schema (don't re-litigate)

**Rule file path:** `rules/<CATEGORY>/<domain>/<id>.md`

**Categories (5, fixed):** `STANDARDS / PROCESS / PATTERNS / ARCHITECTURE / DOCUMENTATION`

**Domains (free-form, growing):** `maintainability / error-handling / methodology / structure / security / observability / perf / naming / idempotency / …`

**Frontmatter (required vs optional):**
```yaml
---
id: kebab-case-globally-unique         # REQUIRED
title: One-line title                  # REQUIRED
category: STANDARDS                    # REQUIRED (one of the 5)
domain: maintainability                # REQUIRED
applies_when:                          # optional but recommended
  paths: ["**/*.ts"]
  symbols: ["fastify.post"]
  intents: ["implement", "refactor"]
severity: high                         # REQUIRED (low|medium|high)
check: ~                               # optional (kind: regex | ast-grep only in v1)
related: []                            # optional
created: 2026-06-09                    # REQUIRED
last_fired: ~                          # maintained by server
fire_count: 0                          # maintained by server
---
```

**Body sections (required):** `## What this rule says` → `## Why it matters` → `## When this applies` → `## What good looks like` → `## Anti-patterns` → `## Examples` (optional).

---

## Phase map (don't conflate)

| Phase | Scope | Effort | Status |
|---|---|---|---|
| **Phase 0 — Day 1 assignment** | Hand-author the 13-rule seed corpus (per eng review §2.2 migration inventory) | 1 day solo | **NOT STARTED** ← this is the next thing |
| **Phase 1.0 — Container + MCP wedge** | TS scaffold, Dockerfile (single-arch arm64), docker-compose.yml, grep-only retrieval, regex-only checks, bearer-token auth, UID/GID compose, 5-day dogfooding gate | 2–3 weeks solo, macOS-only | not started; blocked by Phase 0 |
| **Phase 1.5 — Polish + cross-platform** | Embeddings, ast-grep, multi-arch, install script, launchd auto-start, GitHub Releases | 3–4 weeks | blocked by Phase 1.0 ship |
| **Phase 2 — VSCode extension** | Sidebar, status bar, audit webview, diagnostics, code actions | 3–4 weeks | blocked by Phase 1.0 ship |
| **Phase 3 — Eval lift harness (optional)** | Port rate_limited_webhook_receiver from techdebt, 4-axis lift measurement | ~2 weeks | optional; for when you want a number |
| **Phase 4 — v2** | Sandboxed shell/ts-module rules, remote MCP (claude.ai), self-learning, VSCode Marketplace | months | speculative |

---

## The immediate next 3 actions (in order)

### 1. Execute the corpus migration (TD-R1 from the eng review)

Source: `/Users/nicov/BetterAI/RULES.md` (558 lines, 7 nominal rules of varying depth).

Target: `~/.betterai/rules/` populated with the 13 files specified in the eng review §2.2 inventory:

```
rules/
├── STANDARDS/
│   ├── maintainability/
│   │   ├── simplicity-first.md
│   │   ├── surgical-changes.md
│   │   ├── no-god-files.md
│   │   └── ask-about-non-functionals.md
│   └── error-handling/
│       ├── no-catch-all-exception-masking.md
│       ├── no-defensive-optional-chains.md
│       ├── no-redundant-internal-validation.md
│       └── imports-at-top-not-deferred.md
├── PROCESS/
│   └── methodology/
│       ├── search-context-before-substantive.md
│       ├── checkpoint-context-around-compaction.md
│       ├── goal-driven-execution.md
│       └── think-before-coding.md
├── ARCHITECTURE/
│   └── layering/
│       └── layered-architecture-default.md
└── _meta/
    ├── domain-router.yaml
    ├── schema.md
    └── conflict-resolution.md   # for the "5 overlapping 'don't over-engineer' rules" gap
```

**Eng review caught 11 issues to fix WHILE migrating:**
- "brain" undefined (Rule 1) → make it "search corpus + session memory + web"
- "save context to database" assumes infra v1 doesn't have → rewrite infra-agnostic
- Rule 7 + Section 4.x duplicate content → merge into one file per anti-pattern
- Examples mix Python/JS → pick language-agnostic prose + 1 illustrative language
- No `applies_when` / `severity` anywhere → assign during migration per §2.2 table
- "Substantive" undefined → tighten to "before proposing arch, debugging, recommending tools, or writing >10 lines"

**Budget:** one focused day. Solo. Three lanes possible (STANDARDS-maint / PROCESS / STANDARDS-error-handling) but sequential is fine.

### 2. Write the schema validator (TD-R2)

`_meta/validators/rule-schema.test.ts` — Vitest suite, ~18 tests per the eng review §3.2. Runs in the BetterAI repo when the container scaffold lands; can also run standalone with `bun test` against the rules directory.

**Critical tests:**
- Detect duplicate `id` across the corpus
- Reject `check.kind=shell` and `check.kind=ts-module` (dropped per v4 revision)
- Validate every rule has required H2 sections
- Warn on `related:` pointing to non-existent id
- Warn on `domain:` not in `_meta/domain-router.yaml`

### 3. Start the container scaffold (Phase 1.0 Day 1-3)

After the corpus exists, scaffold the `betterai-server` repo. Per v4 design Phase 1.0:
- TS + `@modelcontextprotocol/sdk`
- Dockerfile (single-arch `linux/arm64` only — defer amd64 to Phase 1.5)
- `docker-compose.yml` with bearer token + UID/GID + 5 volume mounts (per v4 design)
- `retrieve_rules` MCP tool with grep-only matching (no embeddings)
- `check_file` MCP tool with `kind: regex` only
- Audit JSONL emission per the v4-locked schema

---

## Falsification gates (don't skip)

**Day 1 gate:** can you author 13 rules per the §2.2 inventory in one focused day? If not, the corpus has no signal and BetterAI is theater — stop and figure out what's wrong before scaffolding.

**Week 2 gate (Phase 1.0):** 5 consecutive engineering days using Claude Code + BetterAI on real work. ≥5 rules must fire AND ≥3 visible behavior changes (qualitative). If not, re-author rules; the schema isn't the problem, the rule content is.

---

## Unresolved decisions (will come up; decide when forced)

1. **Import techdebt's `templates/PATTERNS.md` / `STANDARDS.md` content?** TD-R9 in the eng review TODOs. Deferred — decide after Phase 1.0 dogfooding tells you which rule shapes are working.
2. **Cross-category rule placement: `related:` field vs symlinks?** *Decided in eng review §1.4: `related:` field.* Don't revisit unless cross-category retrieval feels broken.
3. **Embedding model for Phase 1.5:** MiniLM v2 (free, ~90MB in image, lazy-loaded) vs OpenAI embeddings (better quality, costs $, requires key). *Default: MiniLM.* Revisit only if retrieval quality is the bottleneck.
4. **Conflict-resolution ordering** when multiple rules apply but contradict (e.g., Simplicity says "fewer lines" vs Surgical says "match existing verbosity"). Eng review proposed `_meta/conflict-resolution.md` with explicit priority. *Decide content during migration when you hit the first concrete conflict.*
5. **Phase 3 (eval lift harness) timing:** optional. Trigger when you want hard evidence the corpus moves a quality number. Otherwise the daily-driver gate is the proof.

---

## What NOT to do (lessons from the four design iterations today)

- **Don't build a custom IDE workbench.** v3 designed a full Theia AI desktop app; you rejected it because the corpus, not the chrome, is the value. Don't reverse this.
- **Don't depend on Aether / Aide / GBrain / techdebt at the runtime code level.** Each is a separate world. Cross-pollination via MCP and shared rule files only.
- **Don't add `check.kind=shell` or `ts-module` to v1.** Adversarial review caught this as a critical sandbox issue. Sandboxed execution is v2 behind `network_mode: none` + non-root + read-only rootfs. Until then, prose + regex + ast-grep only.
- **Don't ship with `:latest` Docker tag.** SHA-pin the image in compose; silent updates change retrieval behavior.
- **Don't run the container as root.** `user: "${UID}:${GID}"` is mandatory so audit JSONL is host-user-readable.
- **Don't expose MCP on localhost without a bearer token.** Other local processes (npm postinstall, browser tabs via DNS rebinding) can hit it otherwise.
- **Don't write rules as "prose with embedded code blocks" again.** That's what RULES.md is and it's why migration is non-trivial. Future rules go directly into the per-file schema.
- **Don't conflate categories with domains.** Category (STANDARDS / PROCESS / PATTERNS / ARCHITECTURE / DOCUMENTATION) is mental organization for the human. Domain (maintainability / error-handling / methodology / …) is the agent's retrieval router target. Both are required on every rule. They serve different consumers.

---

## How to re-enter context after a break

1. Read this file (you're here).
2. Skim the v4 design doc — focus on the Architecture v3 ASCII diagram, the Frontmatter Schema, and the Phase Map.
3. Skim the eng review §2.2 migration table (the 13 rules + their destinations).
4. Open `/Users/nicov/BetterAI/RULES.md` — the source content you're migrating.
5. Pick a rule from the migration table, write the file, repeat 12 more times. Day done.

---

## Active reviews / open work

| Item | State | Owner | Next action |
|---|---|---|---|
| v4 design doc | APPROVED | you | Phase 0 starts |
| RULES.md corpus eng review | COMPLETE | you | execute the migration (TD-R1) |
| Schema validator | spec'd, not built | you | TD-R2 |
| Container scaffold | spec'd, not built | you | Phase 1.0 after migration |
| VSCode extension | spec'd, not built | you | Phase 2 after Phase 1.0 dogfooding gate |
| Eval lift harness | optional | you | Phase 3 if you want a number |

---

## Status

**DONE:** four design iterations (v1 → v2 → v3 → v4), three adversarial reviews (v3 caught 13 issues, v4 caught 15, corpus eng review caught 11), one approved design, one approved eng review, two falsification gates defined, schema locked, 13 rule files specified for the seed corpus.

**NOT STARTED:** any code, any rule files written in the new schema, any Docker scaffold, any VSCode extension, any test suite.

**The single next action:** sit down for one focused day and write the 13 rule files per the eng review §2.2 inventory.
