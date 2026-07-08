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

```bash
git clone https://github.com/NicoV7/Personal-Harness.git && cd Personal-Harness
./install.sh                      # uv tool install + betterai install
betterai start                    # compose up: betterai + redis:8.8 + pgvector
betterai index                    # ingest the corpus
betterai doctor
```

Requirements: Docker (compose v2), [uv](https://docs.astral.sh/uv/), an
OpenRouter API key (written to `~/.betterai/openrouter-key`).

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
