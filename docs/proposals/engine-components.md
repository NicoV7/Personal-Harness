# P0-R2: Engine Component Pins (verified 2026-07-06)

Decision record for the Python migration's dependency pins. Verified by
web research against live sources; residual risks listed at the bottom.

## Pins

| Component | Pin | Why / source |
|---|---|---|
| MCP server framework | `fastmcp>=3.4,<4` (standalone PrefectHQ/jlowin, 3.4.3 current) | Official `mcp` SDK has an open unfixed bug (python-sdk #1367) for mounting streamable-HTTP + custom routes on one ASGI app — exactly our hooks-on-same-port pattern. fastmcp documents it first-class (`@mcp.custom_route`, `mcp.http_app()`), ships `StaticTokenVerifier` for plain bearer tokens. |
| `redisvl` | `>=0.23,<0.24` (0.23.0, 2026-07-03) | `HybridQuery` (text+vector, LINEAR/RRF) and `HFCrossEncoderReranker` confirmed present. Requires redis-py >=7.1. |
| Redis image | `redis:8.8` | `redis:8.4` is not a published tag; 8.8 is the current series and satisfies HybridQuery's Redis >=8.4 (FT.HYBRID) floor. |
| Reranker model | `cross-encoder/ms-marco-MiniLM-L6-v2` | 22.7M params vs bge-reranker-base's 278M (~12x smaller); comparable-family CPU benchmarks ~10x faster. Well under 300ms for 20-200 short candidates on CPU. |
| `sentence-transformers` | latest 3.x/4.x at lock time | CrossEncoder API stable; pin exact at `uv lock`. |
| Embeddings | OpenRouter `openai/text-embedding-3-small` (1536 dims) | OpenAI-compatible `POST /api/v1/embeddings` confirmed; cheap at our volume (~30-200 short docs + 1 query/retrieval). `BETTERAI_EMBEDDING_DIM=1536`. |
| Postgres image | `pgvector/pgvector:0.8.4-pg17-bookworm` | Current pgvector on PG17, digest-stable tag. |
| `psycopg` | `psycopg[binary,pool]>=3.3,<4` (3.3.4 current) | Standard PG3 driver + pooling. |

## Build vs adopt

**Build.** Closest OSS: lyonzin/knowledge-rag (hybrid+rerank MCP, but
file-local, no Redis/PG write-through, no hooks gating),
mohllal/markdown-rag-mcp (frontmatter markdown RAG, but Milvus-backed, no
hooks), redis/mcp-redis (generic Redis NL interface, not a corpus server).
None combine our five hard requirements (HTTP-only MCP, hooks-gating
endpoints on the same port, frontmatter rule/skill corpus, PG+Redis
write-through, local Docker). Adopting any would mean rebuilding the
gating/write-through layer anyway.

## Residual risks (verify at implementation)

1. `mcp`/fastmcp progress-notification delivery over streamable-HTTP had a
   historical bug (python-sdk #953, closed): add a smoke test asserting a
   progress notification round-trips against the pinned version.
2. redisvl behavior against Redis <8.4 for HybridQuery is inferred
   (errors, no silent fallback documented): add an integration test
   against the pinned image.
3. OpenRouter embedding-specific pricing/rate limits were not enumerated
   on the docs page; verify against the live account before assuming
   free-tier throughput.
4. fastmcp 3.x moves fast (one custom-route regression reported for
   nested mounts, #3457 — we use a single top-level instance, which
   sidesteps it); re-verify on the exact patch version at lock time.
