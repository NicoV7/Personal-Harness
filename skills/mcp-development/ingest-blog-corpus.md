---
id: ingest-blog-corpus
title: Ingest a blog post into the BetterAI corpus
category: mcp-development
when_to_use: |
  Use when adding a new source post to the corpus, re-ingesting an updated
  post, or debugging why blog-derived artifacts look wrong (missing
  provenance, wrong category, duplicate ids).
forced: false
applies_when:
  paths:
    - app/ingest/**
    - app/corpus/writer.py
  intents:
    - ingest blog
    - distill rules from post
    - re-ingest source
    - blog corpus provenance
created: 2026-07-08
---

## When to use this skill

Use for any change to the blog->corpus pipeline or any operational ingest
run. The pipeline is `betterai ingest <url>` -> POST /ingest ->
fetch -> extract -> chunk -> distill (one LLM call per chunk) ->
corpus write + reindex.

## Steps

1. Run `betterai start` first — ingest is a server-side operation (the
   container holds the OpenRouter key and the corpus mount). There is no
   offline mode.
2. Ingest with `betterai ingest <post-url>`. The summary reports
   `written`, `skipped_chunks` (non-normative chunks the model skipped
   via the {"skip": true} sentinel), and the artifact ids.
3. Re-ingest is idempotent-by-id: chunk ids are `<url-slug>#<index>`, so
   unchanged chunks re-produce the same artifacts and the content-hash
   short-circuit keeps reindexing cheap. If the post's paragraph ORDER
   changed upstream, ids shift — review the diff under the corpus root
   before trusting the run.
4. Verify provenance: every generated artifact carries `source_url` and
   `source_ref` frontmatter pointing at its chunk. `betterai why <file>`
   should surface the new artifacts for matching intents.
5. MUST/NEVER-level prescriptions arrive as `forced: true` rules and are
   unioned into every retrieval — spot-check that only genuinely
   universal rules got the flag, or every prompt pays the context cost.
6. A failed chunk fails the whole run loud (BAI-607 fetch, BAI-608
   distill) — there are no retries. Fix the cause and re-run; already
   written artifacts are simply re-validated.

## What good looks like

One command turns a prose post into reader-valid rules/skills under the
served corpus root, each with provenance, keyword intents (the BM25
channel), and embeddings — and `query_skills` returns them for the
intents they name.
