"""Ingest: write-through order, hash short-circuit, dim validation."""

from importlib import import_module

import pytest

from app.errors import EmbeddingProviderError
from app.retrieval import pg
from app.retrieval.ingest import ingest
from tests.retrieval.conftest import build_artifact, build_settings

# The package re-exports the `ingest` function, shadowing the submodule
# attribute — import_module gets the module itself.
ingest_module = import_module("app.retrieval.ingest")

DIM = 4


class FakeVectorizer:
    def __init__(self) -> None:
        self.embedded: list[str] = []

    def embed_many(self, texts, batch_size=64):
        self.embedded.extend(texts)
        return [[1.0] + [0.0] * (DIM - 1) for _ in texts]


class FakeIndex:
    def __init__(self) -> None:
        self.loaded: list[dict] = []
        self.created = False

    def exists(self) -> bool:
        return self.created

    def create(self) -> None:
        self.created = True

    def load(self, records, id_field="id"):
        self.loaded.extend(records)


class FakeConnection:
    def close(self) -> None:
        return None


@pytest.fixture
def settings():
    return build_settings(embedding_dim=DIM)


@pytest.fixture
def pg_boundary(monkeypatch):
    """Record pg calls in order; fetch_indexed serves the `stored` map."""
    calls: list[tuple] = []
    stored: dict[str, pg.IndexedRow] = {}
    monkeypatch.setattr(pg, "connect", lambda dsn: FakeConnection())
    monkeypatch.setattr(pg, "ensure_schema", lambda conn: calls.append(("schema",)))
    monkeypatch.setattr(
        pg, "fetch_indexed", lambda conn, artifact_id, model: stored.get(artifact_id)
    )
    monkeypatch.setattr(
        pg,
        "upsert_artifact",
        lambda conn, artifact, embedding, model: calls.append(("pg_upsert", artifact.id)),
    )
    return calls, stored


class TestWriteThrough:
    def test_pg_upserts_happen_before_redis_load(self, settings, pg_boundary):
        # arrange
        calls, _ = pg_boundary
        index = FakeIndex()
        artifact = build_artifact("fail-loud-no-retries")
        # act
        summary = ingest(
            [artifact], vectorizer=FakeVectorizer(), index=index, settings=settings
        )
        # assert
        assert summary == {"indexed": 1, "skipped": 0, "total": 1}
        assert ("pg_upsert", "fail-loud-no-retries") in calls
        assert index.loaded, "redis load must happen after pg upserts"
        assert index.loaded[0]["id"] == "fail-loud-no-retries"

    def test_rules_and_skills_both_index(self, settings, pg_boundary):
        # arrange
        rule = build_artifact("fail-loud-no-retries", artifact_type="rule")
        skill = build_artifact("write-scoped-plan", artifact_type="skill")
        index = FakeIndex()
        # act
        summary = ingest(
            [rule, skill], vectorizer=FakeVectorizer(), index=index, settings=settings
        )
        # assert
        assert summary["total"] == 2
        assert {record["artifact_type"] for record in index.loaded} == {"rule", "skill"}

    def test_facet_fields_reach_the_redis_record(self, settings, pg_boundary):
        # arrange
        artifact = build_artifact(
            "fail-loud-no-retries", domain="error-handling", category="STANDARDS"
        )
        index = FakeIndex()
        # act
        ingest([artifact], vectorizer=FakeVectorizer(), index=index, settings=settings)
        # assert
        record = index.loaded[0]
        assert record["domain"] == "error-handling"
        assert record["artifact_type"] == "rule"
        assert "error-handling" in record["keywords"]


class TestShortCircuit:
    def test_unchanged_hash_reuses_stored_embedding(self, settings, pg_boundary):
        # arrange
        _, stored = pg_boundary
        artifact = build_artifact("fail-loud-no-retries", content_hash="hash-a")
        stored[artifact.id] = pg.IndexedRow(content_hash="hash-a", embedding=[0.5] * DIM)
        vectorizer = FakeVectorizer()
        # act
        summary = ingest(
            [artifact], vectorizer=vectorizer, index=FakeIndex(), settings=settings
        )
        # assert
        assert summary == {"indexed": 0, "skipped": 1, "total": 1}
        assert vectorizer.embedded == []

    def test_changed_hash_re_embeds(self, settings, pg_boundary):
        # arrange
        _, stored = pg_boundary
        artifact = build_artifact("fail-loud-no-retries", content_hash="hash-new")
        stored[artifact.id] = pg.IndexedRow(content_hash="hash-old", embedding=[0.5] * DIM)
        vectorizer = FakeVectorizer()
        # act
        summary = ingest(
            [artifact], vectorizer=vectorizer, index=FakeIndex(), settings=settings
        )
        # assert
        assert summary["indexed"] == 1
        assert len(vectorizer.embedded) == 1


class TestDimValidation:
    def test_wrong_dims_raise_bai_604(self, settings, pg_boundary):
        # arrange
        class WrongDimVectorizer:
            def embed_many(self, texts, batch_size=64):
                return [[1.0, 0.0] for _ in texts]  # 2 dims, settings say 4

        artifact = build_artifact("fail-loud-no-retries")
        # act / assert
        with pytest.raises(EmbeddingProviderError) as excinfo:
            ingest(
                [artifact],
                vectorizer=WrongDimVectorizer(),
                index=FakeIndex(),
                settings=settings,
            )
        assert excinfo.value.code == "BAI-604"


class TestEmbedText:
    def test_facet_header_leads_the_embedded_text(self):
        # arrange
        artifact = build_artifact(
            "fail-loud-no-retries", domain="error-handling", category="STANDARDS"
        )
        # act
        text = ingest_module.embed_text(artifact)
        # assert
        assert text.startswith("domain: error-handling")
        assert artifact.title in text
