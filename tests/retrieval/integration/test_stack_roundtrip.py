"""Live-stack round-trip: ingest -> HybridQuery -> threshold selection.

Needs real redis (>=8.4 for FT.HYBRID) and postgres reachable via
BETTERAI_TEST_REDIS_URL / BETTERAI_TEST_POSTGRES_DSN; skips otherwise so
the plain gate stays green. Embeddings are a deterministic stub: this
suite proves the redisvl index and the write-through, not OpenRouter.
"""

from __future__ import annotations

import asyncio
import os

import pytest
import redis as redis_lib

from app.corpus.schema import Artifact
from app.retrieval import Retrieval
from app.retrieval import pg
from app.retrieval.ingest import ingest, make_index
from app.retrieval.search import search
from app.settings import Settings

pytestmark = pytest.mark.integration

DIM = 8


class StubVectorizer:
    """Deterministic unit vectors: 'network' text points one way, other
    text another, so cosine similarity is controlled per test."""

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * DIM
        vector[0 if "network" in text.lower() else 1] = 1.0
        return vector

    def embed(self, text: str) -> list[float]:
        return self._vector(text)

    def embed_many(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        return [self._vector(text) for text in texts]


def _artifact(artifact_id: str, title: str, body: str, domain: str) -> Artifact:
    return Artifact(
        id=artifact_id,
        artifact_type="rule",
        scope="global",
        title=title,
        category="STANDARDS",
        domain=domain,
        severity="high",
        body=body,
        content_hash="",
        source_path=f"/tmp/{artifact_id}.md",
    )


@pytest.fixture
def stack_settings(full_env: dict[str, str], tmp_path) -> Settings:
    redis_url = os.environ.get("BETTERAI_TEST_REDIS_URL")
    postgres_dsn = os.environ.get("BETTERAI_TEST_POSTGRES_DSN")
    if not redis_url or not postgres_dsn:
        pytest.skip("live stack env (BETTERAI_TEST_REDIS_URL/_POSTGRES_DSN) not set")
    client = redis_lib.Redis.from_url(redis_url)
    for key in client.scan_iter("betterai:artifact*"):
        client.delete(key)
    client.close()
    key_file = tmp_path / "openrouter-key"
    key_file.write_text("integration-test-key")
    env = {
        **full_env,
        "BETTERAI_REDIS_URL": redis_url,
        "BETTERAI_POSTGRES_DSN": postgres_dsn,
        "BETTERAI_EMBEDDING_DIM": str(DIM),
        "BETTERAI_OPENROUTER_API_KEY_FILE": str(key_file),
        "BETTERAI_SIMILARITY_THRESHOLD": "0.9",
    }
    return Settings.from_env(env)


class TestStackRoundtrip:
    def test_ingest_then_hybrid_search_selects_by_threshold_and_keyword(self, stack_settings):
        # arrange
        vectorizer = StubVectorizer()
        index = make_index(stack_settings)
        network_rule = _artifact(
            "fail-loud-network",
            "Fail loud on network errors",
            "For networking calls: one attempt, raise a typed error, no retries.",
            "error-handling",
        )
        testing_rule = _artifact(
            "tests-by-feature",
            "Organize tests by feature",
            "Tests live under a feature directory with a type subdirectory.",
            "testing",
        )
        # act
        summary = ingest(
            [network_rule, testing_rule],
            vectorizer=vectorizer,
            index=index,
            settings=stack_settings,
        )
        hits = search(
            "how do I handle network errors",
            vectorizer=vectorizer,
            index=index,
            settings=stack_settings,
        )
        # assert
        assert summary["total"] == 2
        hit_ids = [hit["id"] for hit in hits]
        assert "fail-loud-network" in hit_ids
        assert "tests-by-feature" not in hit_ids  # orthogonal vector: below threshold

    def test_write_through_persists_rows_in_postgres(self, stack_settings):
        # arrange
        vectorizer = StubVectorizer()
        index = make_index(stack_settings)
        artifact = _artifact(
            "pg-roundtrip-check",
            "Postgres write-through check",
            "Network rule body for the write-through assertion.",
            "error-handling",
        )
        # act
        ingest([artifact], vectorizer=vectorizer, index=index, settings=stack_settings)
        conn = pg.connect(stack_settings.postgres_dsn)
        try:
            stored = pg.fetch_indexed(
                conn, artifact.id, stack_settings.openrouter_embedding_model
            )
        finally:
            conn.close()
        # assert
        assert stored is not None
        assert len(stored.embedding) == DIM

    def test_facade_maps_hits_back_to_artifacts(self, stack_settings):
        # arrange: bypass __init__ so no OpenRouter client is constructed
        retrieval = Retrieval.__new__(Retrieval)
        retrieval._settings = stack_settings
        retrieval._vectorizer = StubVectorizer()
        retrieval._index = make_index(stack_settings)
        retrieval._artifacts = {}
        network_rule = _artifact(
            "facade-network-rule",
            "Networking failures fail loud",
            "One attempt per network call; typed error on failure.",
            "error-handling",
        )
        # act
        summary = asyncio.run(retrieval.index_corpus([network_rule]))
        results = asyncio.run(retrieval.query(intent="network error handling"))
        # assert
        assert summary["total"] == 1
        assert any(r.artifact.id == "facade-network-rule" for r in results)
