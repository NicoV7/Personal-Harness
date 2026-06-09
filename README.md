# BetterAI

**A Dockerized rule corpus + MCP retrieval service that injects relevant code-quality, design, and maintainability rules into any AI agent's context BEFORE the agent writes or plans code.**

The corpus is the moat. The container is the install vector. Any MCP-speaking agent (Claude Code, Cursor, Codex CLI, Gemini CLI, claude.ai managed agents) gets the rules for free.

This is a **personal toolkit**. Single user. Local-first. No SaaS.

---

## Install in 5 commands

```bash
# 1. Create the corpus root on the host.
mkdir -p ~/.betterai/{rules,skills,memories,audit}

# 2. Bootstrap docker-compose.yml + a one-shot install of the seed corpus.
curl -fsSL https://betterai.dev/install.sh | sh

# 3. Bring up the container (single-arch arm64 in v1.0; multi-arch in v1.5).
docker compose -f ~/.betterai/docker-compose.yml up -d

# 4. Verify the server is alive and your bearer token is wired up.
betterai status

# 5. Point Claude Code at the MCP endpoint.
#    (The install script prints the exact snippet to paste, with the
#    bearer token interpolated; see docs/DEBUGGING.md if you skipped it.)
```

Five commands. No npm. No Node version dance. The container ships its own runtime.

---

## Your first magical moment

After install, open the welcome task that ships with the seed corpus:

```bash
betterai welcome
# Walks you through a single five-minute fixture:
#   1. Open a contrived bad-code file.
#   2. Ask Claude Code to refactor it.
#   3. Watch BetterAI's retrieve_context fire BEFORE Claude writes anything.
#   4. See the rules show up in Claude's planning output.
```

This is the moment the system has signal or it doesn't. If the rules don't change Claude's output, the corpus is wrong, not the plumbing — see [docs/DEBUGGING.md](docs/DEBUGGING.md).

---

## What's in the corpus

Three artifact kinds, each with its own retrieval call:

- **Rules** — constraints. "Don't catch all exceptions." Read BEFORE writing code.
- **Skills** — procedures. "How to add a new MCP tool." Read when about to perform a task that matches.
- **Memories** — episodes. "Last time we tried Theia, here's why we rejected it." Read when planning or debugging matches a prior decision.

Two scopes:

- **GLOBAL** (`~/.betterai/`) — applies to every project you touch from this machine.
- **REPO** (`<repo-root>/.betterai/`) — ships with the project, gets PR'd like code, survives team handoffs.

The full schema lives in [`rules/_meta/schema.md`](rules/_meta/schema.md). Conflict resolution (rule vs memory, repo vs global) lives in [`rules/_meta/conflict-resolution.md`](rules/_meta/conflict-resolution.md).

---

## How it works

```
   Any MCP-speaking agent              betterai-server (Docker)
   ─────────────────────               ─────────────────────────
   retrieve_context(context) ───HTTP──▶ domain-router → grep (v1)
                                        → merge global + repo
                                        → LRU cache (256/60s)
                                        → return {rules, skills, memories}
                              ◀──JSON─── + audit JSONL append
```

A single MCP server binds `127.0.0.1:7777` with a bearer token. Every retrieval is audited to JSONL for replay. The corpus on disk is read-write to the user; the projects mount is read-only to the container. Detection of which `.betterai/` directory ships with the active repo happens by walking up to the nearest `.git/` — see [`docs/design/v4.1-scoping-extension.md`](docs/design/v4.1-scoping-extension.md).

---

## Authoring

The lazy path is `betterai new rule` — it asks two questions and creates the file. The manual path is documented frontmatter-key-by-frontmatter-key in [`docs/AUTHORING.md`](docs/AUTHORING.md).

The first thing to read when writing a rule by hand is [`rules/_meta/schema.md`](rules/_meta/schema.md).

---

## Debugging

When the agent's output looks wrong, the three diagnostics — in this order — are:

1. `betterai status` — is the container alive, is the token wired up, how many rules in each scope.
2. `betterai why <task> --context <file>` — which rules would have fired for that input.
3. `betterai replay --since 7d` — weekly digest of what fired vs what was applied.

The full diagnostic loop, the `[BAI-NNN]` error-code table, and the common gotchas live in [`docs/DEBUGGING.md`](docs/DEBUGGING.md).

---

## Phase status

The container scaffold is wedge code. The corpus is the part that compounds. See [`docs/IMPLEMENTATION-ROADMAP.html`](docs/IMPLEMENTATION-ROADMAP.html) for the phased plan and current gate status.

In short:

- **Phase 0** — hand-author the 13-rule seed corpus. *Done.*
- **Phase 1.0** — container + MCP wedge (grep retrieval, regex checks, bearer auth, single-arch arm64). *Wave 3 in flight.*
- **Phase 1.5** — embeddings, ast-grep, multi-arch, install script, launchd.
- **Phase 2** — VSCode extension (sidebar, audit webview, diagnostics).
- **Phase 3** — eval-lift harness (optional, for hard evidence the corpus moves a number).

---

## What this is NOT

- Not a product. There is no marketplace, no SaaS, no auth provider.
- Not a custom IDE. VSCode is the surface; we don't ship our own editor.
- Not a runtime dependency of any other project. Aether, Aide, GBrain, techdebt: each is a separate world. Cross-pollination via MCP and shared rule files only.

---

## License

Personal toolkit. No license declared. Don't redistribute the corpus content; the seed rules encode the author's design opinions.
