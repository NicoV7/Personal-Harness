"""Blog ingestion: fetch -> extract -> chunk -> distill -> corpus write.

Turns prose engineering posts into retrievable corpus artifacts (rules
and skills) with embeddings, keyword intents, and provenance. Exposed as
POST /ingest (ops endpoint) driven by `betterai ingest <url>` — NOT an
MCP tool; the 5-tool agent surface stays frozen.
"""
