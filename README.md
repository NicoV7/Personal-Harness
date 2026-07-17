# BetterAI

**A Python MCP harness that injects your skills and rules into any coding
agent's context in real time — hybrid RAG over Redis, hard gates that
make consultation deterministic, and a markdown corpus as the source of
record.**

Any MCP-speaking agent (Claude Code, Codex CLI, Cursor, Gemini CLI) gets
the corpus for free. Personal toolkit: single user, local-first, no SaaS.

> The original TypeScript implementation is deprecated and removed; it
> lives in git history prior to the `feat/python-refocus` branch.

## How it works

```
prompt -> UserPromptSubmit hook -> query_skills (redisvl HybridQuery:
BM25 + vector, per-aspect) -> skills above the cosine-similarity
threshold with a keyword match -> get_skill read receipts -> gates keep
mutating tools denied until the skills are actually read
```

- **Ingest** (`app/retrieval/ingest.py`): markdown + YAML frontmatter →
  redisvl vectorizer (OpenRouter, OpenAI-compatible) → write-through
  Postgres (durable) then Redis (hot hybrid index). Facets (`domain`,
  `category`, intents) are indexed as tags, BM25 keywords, and an
  embedded header so phase-specific queries land reliably.
- **Query** (`app/retrieval/search.py`): one `HybridQuery` per aspect
  (pass one aspect per sub-problem of your task); selection rule =
  `cosine similarity >= BETTERAI_SIMILARITY_THRESHOLD` AND keyword
  match; `top_k` is optional — omitted means read everything relevant.
- **Tools** (5): `query_skills` · `get_skill` · `edit_skill` ·
  `list_skills` · `start_container`.
- **Gates** (4, hook-driven): skill read-gate, retrieval receipt, plan
  manifest (`## Files to touch` + `justify:` escape hatch), incremental
  edit budget (`BETTERAI_EDIT_GRANULARITY=function|file|none`).
- **Fail loud, no defaults**: every config key is required (boot lists
  what's missing, BAI-120); no retries, no silent fallbacks, no offline
  mode — errors tell you to run `betterai start`.

## Install

One command (installs uv if missing, checks Docker, then chains
install → start → index → doctor; safe to re-run):

```bash
curl -fsSL https://raw.githubusercontent.com/NicoV7/Personal-Harness/main/bootstrap.sh | sh
```

From a checkout, `./install.sh` runs the same bootstrap. The OpenRouter
key is prompted interactively (or pass `BETTERAI_OPENROUTER_KEY_FILE=…`);
leaving it empty installs in degraded mode — the server runs but
retrieval/index fail loud until a key lands in `~/.betterai/openrouter-key`.

Requirements: Docker (compose v2). Everything else is bootstrapped.

## Dashboard

```bash
betterai ui                       # opens http://127.0.0.1:7788 (or a free port)
```

Local-only web UI: skills manager (browse/edit/configure/add), logs &
traces from the audit JSONL grouped by agent session, doctor panel with
fix hints, and a usage stats strip. No telemetry — every number is
computed from files under `~/.betterai`.

## Development

```bash
uv venv .venv && uv pip install -e ".[dev]"
.venv/bin/pytest tests -m "not integration and not e2e" -q   # fast gate
.venv/bin/pytest tests -m integration                        # needs live redis/pg
```

Tests are feature-first: `tests/<feature>/{unit,integration,e2e,evals}/`.

## Layout

```
app/            server, settings (no defaults), errors (BAI codes),
                corpus/ (reader, router), retrieval/ (ingest, search, pg),
                mcp/ (one folder per tool and per gate), hooks/ (event
                pipeline), installer/, cli.py
tests/          feature-first suites + product evals (rubric-driven A/B)
rules/ skills/  the corpus (markdown + YAML frontmatter)
docs/           proposals, debugging, eval harness design
```
