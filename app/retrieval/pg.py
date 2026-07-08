"""Postgres/pgvector helpers: the durable side of the write-through pair.

Postgres is the derived store of record for indexed artifacts and their
embeddings (corpus markdown stays the true source). Helpers are sync
psycopg3 on purpose — indexing is a boot/CLI-time path, not a request
hot path. Connection failure is BAI-601 with the start prompt; write
failures are BAI-603 so callers never see driver exceptions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import psycopg

from app.corpus.schema import Artifact
from app.errors import Errors

ARTIFACTS_DDL = """
CREATE TABLE IF NOT EXISTS artifacts (
    id text PRIMARY KEY,
    artifact_type text NOT NULL CHECK (artifact_type IN ('rule', 'skill')),
    scope text NOT NULL,
    format text NOT NULL,
    content_hash text NOT NULL,
    frontmatter jsonb NOT NULL,
    body text NOT NULL,
    indexed_at timestamptz NOT NULL
)
"""

EMBEDDINGS_DDL = """
CREATE TABLE IF NOT EXISTS embeddings (
    artifact_id text REFERENCES artifacts(id) ON DELETE CASCADE,
    model text NOT NULL,
    dim int NOT NULL,
    embedding vector,
    PRIMARY KEY (artifact_id, model)
)
"""

UPSERT_ARTIFACT_SQL = """
INSERT INTO artifacts (id, artifact_type, scope, format, content_hash, frontmatter, body, indexed_at)
VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
ON CONFLICT (id) DO UPDATE SET
    artifact_type = EXCLUDED.artifact_type,
    scope = EXCLUDED.scope,
    format = EXCLUDED.format,
    content_hash = EXCLUDED.content_hash,
    frontmatter = EXCLUDED.frontmatter,
    body = EXCLUDED.body,
    indexed_at = EXCLUDED.indexed_at
"""

UPSERT_EMBEDDING_SQL = """
INSERT INTO embeddings (artifact_id, model, dim, embedding)
VALUES (%s, %s, %s, %s::vector)
ON CONFLICT (artifact_id, model) DO UPDATE SET
    dim = EXCLUDED.dim,
    embedding = EXCLUDED.embedding
"""

FETCH_INDEXED_SQL = """
SELECT a.content_hash, e.embedding::text
FROM artifacts a
JOIN embeddings e ON e.artifact_id = a.id AND e.model = %s
WHERE a.id = %s
"""

ARTIFACT_FORMAT = "md"


@dataclass(frozen=True)
class IndexedRow:
    """What the indexer needs to decide re-embed vs reuse."""

    content_hash: str
    embedding: list[float]


def connect(dsn: str) -> psycopg.Connection:
    try:
        return psycopg.connect(dsn, autocommit=True)
    except psycopg.OperationalError as exc:
        raise Errors.stack_unavailable("postgres", str(exc)) from exc


def ensure_schema(conn: psycopg.Connection) -> None:
    """Idempotent DDL: extension first because the embeddings table needs
    the vector type to exist."""
    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        conn.execute(ARTIFACTS_DDL)
        conn.execute(EMBEDDINGS_DDL)
    except psycopg.Error as exc:
        raise Errors.index_write_error(f"postgres schema setup failed: {exc}", cause=exc) from exc


def fetch_indexed(
    conn: psycopg.Connection, artifact_id: str, model: str
) -> IndexedRow | None:
    """Hash + stored embedding for one artifact, or None if never indexed
    for this model. Powers the indexer's re-embed short-circuit."""
    try:
        row = conn.execute(FETCH_INDEXED_SQL, (model, artifact_id)).fetchone()
    except psycopg.Error as exc:
        raise Errors.query_error(f"postgres lookup for {artifact_id} failed: {exc}", cause=exc) from exc
    if row is None:
        return None
    return IndexedRow(content_hash=row[0], embedding=parse_vector_text(row[1]))


def upsert_artifact(
    conn: psycopg.Connection, artifact: Artifact, embedding: list[float], model: str
) -> None:
    try:
        conn.execute(
            UPSERT_ARTIFACT_SQL,
            (
                artifact.id,
                artifact.artifact_type,
                artifact.scope,
                ARTIFACT_FORMAT,
                artifact.content_hash or "",
                json.dumps(artifact.model_dump(mode="json", exclude={"body"})),
                artifact.body,
            ),
        )
        conn.execute(
            UPSERT_EMBEDDING_SQL,
            (artifact.id, model, len(embedding), vector_text(embedding)),
        )
    except psycopg.Error as exc:
        raise Errors.index_write_error(f"postgres upsert of {artifact.id} failed: {exc}", cause=exc) from exc


def vector_text(embedding: list[float]) -> str:
    """pgvector literal form; avoids a pgvector-python dependency."""
    return "[" + ",".join(repr(value) for value in embedding) + "]"


def parse_vector_text(raw: str) -> list[float]:
    stripped = raw.strip().lstrip("[").rstrip("]")
    if not stripped:
        return []
    return [float(part) for part in stripped.split(",")]
