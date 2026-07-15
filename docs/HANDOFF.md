# BetterAI — Handoff (2026-07-08, post-Python-refocus)

> Supersedes the 2026-06-10 TS-era handoff. As of PR #1 (merge `0df4633`),
> **this repo IS the Python harness**; the TypeScript implementation is
> deleted and lives only in git history before `feat/python-refocus`.

## State

- `main` @ `0df4633`. Fast gate: `pytest tests -m "not integration and not e2e"`
  → **155 passed** from the repo root. Boot proof: `env -i python -m app.main`
  exits 1 printing BAI-120 with every missing key.
- App is ~4.9k lines under `app/`; tests are feature-first
  (`tests/<feature>/{unit,integration,e2e,evals}/`).
- Local dirt (deliberate): `docs/EVAL-HARNESS.md` has uncommitted user WIP;
  `src/` holds never-committed TS WIP files (untracked, invisible to git —
  delete when ready).

## Architecture (one paragraph)

FastMCP Streamable-HTTP server (no stdio, ever) on 127.0.0.1:7777 with
bearer auth; 5 MCP tools (`query_skills`, `get_skill`, `edit_skill`,
`list_skills`, `start_container`); hooks are an ordered handler pipeline
(`app/hooks/{events,chain,state}.py`) driving 4 gates (skill read
receipts, retrieval receipt, plan manifest with `## Files to touch` +
`justify:` escape, incremental edit budget via
`BETTERAI_EDIT_GRANULARITY`). Retrieval is idiomatic redisvl:
`app/retrieval/ingest.py` (frontmatter → OpenRouter vectorizer →
write-through **PG first, then Redis**; facets indexed as tags + BM25
keywords + embedded header; content-hash short-circuit) and
`app/retrieval/search.py` (one `HybridQuery` per **aspect**; selection =
cosine similarity ≥ `BETTERAI_SIMILARITY_THRESHOLD` AND keyword match;
`top_k` optional — omitted returns everything relevant). Config has NO
defaults (`app/settings.py` REQUIRED_KEYS, BAI-120 lists missing); errors
are typed BAI-xxx from `app/errors.py`; no retries/backoff/offline mode
anywhere — failures say "run `betterai start`".

## Decision log pointers

- Pins: `docs/proposals/engine-components.md` (fastmcp 3.4.x, redisvl
  0.23, redis:8.8 image — the 8.4 tag does not exist, pgvector pg17,
  OpenRouter `openai/text-embedding-3-small` @1536).
- Memory provider: `docs/proposals/memory-tool-selection.md`
  (**basic-memory** selected, cognee behind `BETTERAI_MEMORY_PROVIDER`).
- Cross-encoder rerank was built then **removed** (user decision:
  hybrid + threshold only; torch dependency gone). `kind` was renamed
  `artifact_type` everywhere (user: nondescriptive names are a smell).

## Next (in order)

1. **Live-stack verification**: `./install.sh` → `betterai start` →
   `betterai index` → `pytest -m integration` (proves HybridQuery
   round-trip on redis:8.8 and PG write-through). Requires Docker up and
   an OpenRouter key at the configured key file. The one genuinely
   unverified fact: whether `vector_similarity` yielded under RRF fusion
   is a true cosine similarity — the integration test decides; if not,
   adjust `similarity()` in `app/retrieval/search.py` (one function).
2. **Real-agent smoke**: Claude Code through the Supergateway bridge —
   query_skills → get_skill receipts → gate deny/allow round-trip.
3. **P8 evals**: port install-smoke into `app/cli.py eval`; build
   `eval run` two-arm A/B with the blind LLM code-review judge (rubric =
   `tests/product/evals/rubric-blogs.yaml` + corpus criteria from served
   skills; fixtures already in `tests/product/evals/fixtures/`).
4. Small deferred cleanups: move forced-skill matching from
   `app/mcp/query_skills/handler.py` into `corpus/reader.forced_for()`;
   swap the reader's hand-rolled frontmatter split for
   `python-frontmatter`; `docs/MCP-TOOLS.md` (5-tool contract) still to
   be written; Windows path translation is a named milestone.

## Gotchas for the next session

- The repo-scope corpus (`.betterai/`) is gitignored by design; the
  deprecated `cli-read-ops-work-offline` rule edit lives there locally.
- ECC GateGuard hooks demand "facts" text in the same message as the
  first Bash/Edit/Write per file — expect one denial+retry rhythm.
- `app/retrieval/__init__.py` re-exports `ingest`/`search` functions,
  shadowing the submodules — tests monkeypatching module attributes must
  use `importlib.import_module("app.retrieval.search")`.
- `eval-output/`, `seed-corpus/`, `scripts/`, `RULES.md`,
  `TODO-strictness-sweep.md` are TS-era leftovers kept deliberately
  (surgical deletion only); prune in a follow-up if unwanted.
