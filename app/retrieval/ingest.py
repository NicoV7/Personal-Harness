"""Ingest: corpus artifacts -> redisvl vectorizer -> write-through PG then Redis.

The lean path: parse (corpus reader) -> embed with redisvl's own
OpenAI-compatible vectorizer pointed at OpenRouter -> load one search
index carrying the BM25 text fields, the facet tags, and the vector.

Facets are load-bearing for retrieval quality: skills cover different
parts of the full-stack process (e.g. fail-hard error handling is
specifically for networking), so `domain` and `category` are indexed as
filterable tags AND folded into the keywords text and the embedded
header line — a phase-specific query matches on all three signals.

PG is upserted FIRST so Redis is always rebuildable from durable rows; a
content-hash short-circuit reuses stored embeddings for unchanged
artifacts.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import redis.exceptions
from redisvl.index import SearchIndex
from redisvl.redis.utils import array_to_buffer
from redisvl.utils.vectorize import OpenAITextVectorizer

from app.corpus.schema import Artifact
from app.errors import Errors
from app.retrieval import pg
from app.settings import Settings

INDEX_NAME = "betterai"
KEY_PREFIX = "betterai:artifact"
INDEXED_ARTIFACT_TYPES = ("rule", "skill")
EMBED_BATCH = 64
VECTOR_DTYPE = "float32"


def index_schema(dim: int) -> dict:
    return {
        "index": {"name": INDEX_NAME, "prefix": KEY_PREFIX, "storage_type": "hash"},
        "fields": [
            {"name": "id", "type": "tag"},
            {"name": "artifact_type", "type": "tag"},
            {"name": "scope", "type": "tag"},
            {"name": "severity", "type": "tag"},
            {"name": "domain", "type": "tag"},
            {"name": "category", "type": "tag"},
            {"name": "title", "type": "text"},
            {"name": "body", "type": "text"},
            {"name": "keywords", "type": "text"},
            {
                "name": "embedding",
                "type": "vector",
                "attrs": {
                    "dims": dim,
                    "distance_metric": "cosine",
                    "algorithm": "flat",  # exact KNN: deterministic ranking
                    "datatype": VECTOR_DTYPE,
                },
            },
        ],
    }


def make_vectorizer(settings: Settings) -> OpenAITextVectorizer:
    key_path = Path(settings.openrouter_api_key_file)
    if not key_path.exists():
        raise Errors.token_missing(str(key_path))
    key = key_path.read_text().strip()
    if not key:
        raise Errors.token_missing(str(key_path))
    try:
        return OpenAITextVectorizer(
            model=settings.openrouter_embedding_model,
            api_config={"api_key": key, "base_url": settings.openrouter_base_url},
            dtype=VECTOR_DTYPE,
        )
    except Exception as exc:  # redisvl probes the provider at construction
        raise Errors.embedding_provider(str(exc)) from exc


def make_index(settings: Settings) -> SearchIndex:
    try:
        return SearchIndex.from_dict(
            index_schema(settings.embedding_dim), redis_url=settings.redis_url
        )
    except redis.exceptions.RedisError as exc:
        raise Errors.stack_unavailable("redis", str(exc)) from exc


def embed_text(artifact: Artifact) -> str:
    """Facet header first so phase-specific queries ("networking error
    handling") land semantically even when the body wording differs."""
    header_parts = [
        part
        for part in (
            f"domain: {artifact.domain}" if artifact.domain else "",
            f"category: {artifact.category}" if artifact.category else "",
            f"applies when: {_intents(artifact)}" if _intents(artifact) else "",
        )
        if part
    ]
    sections = (" · ".join(header_parts), artifact.title, artifact.when_to_use or "", artifact.body)
    return "\n\n".join(section for section in sections if section)


def keywords_text(artifact: Artifact) -> str:
    """The BM25 keyword field: intents + facets, space-joined."""
    parts = [_intents(artifact), artifact.domain or "", artifact.category or ""]
    return " ".join(part for part in parts if part)


def _intents(artifact: Artifact) -> str:
    if artifact.applies_when is None:
        return ""
    return " ".join(artifact.applies_when.intents or [])


def content_hash(artifact: Artifact) -> str:
    """Reader-stamped hash wins; otherwise hash exactly the embedded text
    so any change that would alter the embedding also changes the hash."""
    if artifact.content_hash:
        return artifact.content_hash
    return hashlib.sha256(embed_text(artifact).encode("utf-8")).hexdigest()


def ingest(
    artifacts: list[Artifact],
    *,
    vectorizer: OpenAITextVectorizer,
    index: SearchIndex,
    settings: Settings,
) -> dict:
    batch = [a for a in artifacts if a.artifact_type in INDEXED_ARTIFACT_TYPES]
    model = settings.openrouter_embedding_model
    conn = pg.connect(settings.postgres_dsn)
    try:
        pg.ensure_schema(conn)
        embeddings, fresh = _resolve_embeddings(conn, batch, model, vectorizer, settings)
        for artifact in batch:  # PG first: Redis stays rebuildable from PG
            pg.upsert_artifact(conn, artifact, embeddings[artifact.id], model)
    finally:
        conn.close()
    _load_redis(index, batch, embeddings)
    return {"indexed": len(fresh), "skipped": len(batch) - len(fresh), "total": len(batch)}


def _resolve_embeddings(
    conn, batch: list[Artifact], model: str, vectorizer, settings: Settings
) -> tuple[dict[str, list[float]], list[Artifact]]:
    embeddings: dict[str, list[float]] = {}
    fresh: list[Artifact] = []
    for artifact in batch:
        stored = pg.fetch_indexed(conn, artifact.id, model)
        if stored is not None and stored.content_hash == content_hash(artifact):
            embeddings[artifact.id] = stored.embedding
            continue
        fresh.append(artifact)
    if fresh:
        vectors = embed_many(vectorizer, [embed_text(a) for a in fresh], settings.embedding_dim)
        embeddings.update({a.id: v for a, v in zip(fresh, vectors)})
    return embeddings, fresh


def embed_many(vectorizer, texts: list[str], dim: int) -> list[list[float]]:
    try:
        vectors = vectorizer.embed_many(texts, batch_size=EMBED_BATCH)
    except Exception as exc:  # re-raised typed: provider failure must say so
        raise Errors.embedding_provider(str(exc)) from exc
    for vector in vectors:
        if len(vector) != dim:
            raise Errors.embedding_provider(f"expected {dim} dims, got {len(vector)}")
    return [[float(value) for value in vector] for vector in vectors]


def _load_redis(index: SearchIndex, batch: list[Artifact], embeddings: dict) -> None:
    records = [
        {
            "id": artifact.id,
            "artifact_type": artifact.artifact_type,
            "scope": artifact.scope,
            "severity": artifact.severity or "",
            "domain": artifact.domain or "",
            "category": artifact.category or "",
            "title": artifact.title,
            "body": artifact.body,
            "keywords": keywords_text(artifact),
            "when_to_use": artifact.when_to_use or "",
            "embedding": array_to_buffer(embeddings[artifact.id], dtype=VECTOR_DTYPE),
        }
        for artifact in batch
    ]
    try:
        if not index.exists():
            index.create()
        if records:
            index.load(records, id_field="id")
    except redis.exceptions.RedisError as exc:
        raise Errors.stack_unavailable("redis", str(exc)) from exc
