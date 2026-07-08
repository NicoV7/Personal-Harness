# P0-R1: OSS Memory Tool Selection (verified 2026-07-06)

Decision record for replacing record_memory/retrieve_memories with an
open-source memory layer installed alongside BetterAI. Provider is
switchable via `BETTERAI_MEMORY_PROVIDER` (basic-memory | cognee | none —
explicit, no default).

## Winner: basic-memory (basicmachines-co) — cognee as switchable fallback

basic-memory's native storage unit IS "markdown file with YAML
frontmatter + prose body" — our exact current format, so migration is a
frontmatter field remap rather than an ETL pipeline. First-party MCP
server in Docker (`ghcr.io/basicmachines-co/basic-memory:latest`) with
stdio, SSE (proven in the maintainers' own compose), and documented
streamable-http transports. Fully local by default (SQLite + local
FastEmbed), no cloud account. Bodies stored verbatim — no LLM rewrite.

## Why not the others

- **mem0 / OpenMemory MCP**: OpenMemory officially sunset (mem0 #4923);
  first-party mem0-mcp repo archived 2026-03, cloud-only. Writes run an
  LLM fact-extraction pass (lossy, not verbatim).
- **letta (MemGPT)**: an MCP *client*/agent runtime, not a memory server
  other agents call. Wrong shape.
- **cognee**: strongest retrieval (graph + vector, native streamable
  HTTP, can reuse our Postgres) but its MCP surface (remember/recall/
  forget) has no slot for structured frontmatter and every write triggers
  an LLM "cognify" pass — cost, latency, fidelity regression. Kept as the
  `BETTERAI_MEMORY_PROVIDER=cognee` option behind the provider seam.

## Install (compose service, alongside BetterAI, provider=basic-memory)

```yaml
basic-memory:
  image: ghcr.io/basicmachines-co/basic-memory:latest
  command: ["basic-memory", "mcp", "--transport", "sse", "--host", "0.0.0.0", "--port", "8000"]
  ports: ["127.0.0.1:8010:8000"]
  volumes:
    - <BETTERAI_HOME>/memories-bm:/app/data:rw
    - basic-memory-config:/home/appuser/.basic-memory:rw
  environment:
    BASIC_MEMORY_DEFAULT_PROJECT: betterai
    BASIC_MEMORY_SYNC_CHANGES: "true"
```

Transport note: SSE is proven in the project's own compose; confirm the
streamable-http flag string via `basic-memory mcp --help` at
implementation. If flaky, bridge with Supergateway
(`--sse http://basic-memory:8000/sse --outputTransport streamableHttp`).
Endpoints are unsecured by default: bind 127.0.0.1 only (same posture as
BetterAI itself).

## Export mapping (betterai memory frontmatter -> basic-memory)

| Ours | basic-memory |
|---|---|
| `id` | filename slug / `permalink` |
| `title` | `title` |
| `date` | `date` |
| `project` | Basic Memory project namespace |
| `kind` (decision/failure/discovery/constraint) | `type` field or `#kind/<value>` tag |
| `context_keywords[]` | `tags[]` |
| `durability`, `auto_captured`, `related_rules`, `related_memories`, `expires_on` | custom frontmatter keys (preserved as-is) |
| `body` | markdown body verbatim |

## Residual risks

- AGPL-3.0 license: fine for internal/localhost use; legal review before
  any public redistribution or hosted offering.
- Star count/version varied across sources; re-check live before pinning.
- Retrieval is vector + optional wikilink graph — less rich than cognee's
  knowledge graph; the provider env makes the cognee spike cheap later.
