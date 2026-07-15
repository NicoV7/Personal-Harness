"""POST /reindex: corpus -> pipeline.index_corpus wiring, audit, auth.

Fakes sit only at the cross-module seams (pipeline, corpus); audit log
and bearer middleware are the real implementations against tmp_path.
"""

from __future__ import annotations

import json

from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.auth import BearerAuth, BearerAuthMiddleware
from app.errors import Errors
from app.server import ops_routes
from tests.mcp.gate_helpers import FakeCorpus, FakePipeline, make_deps, make_settings, make_skill

TOKEN = "reindex-test-token"


def _client_and_deps(tmp_path, *, pipeline=None, corpus=None):
    settings = make_settings(tmp_path, allowed_hosts=("testserver",))
    deps = make_deps(tmp_path, settings=settings, pipeline=pipeline, corpus=corpus)
    (tmp_path / "token").write_text(TOKEN + "\n")
    app = BearerAuthMiddleware(
        Starlette(routes=ops_routes(deps)), BearerAuth(settings, deps.audit)
    )
    return TestClient(app), deps


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


class TestReindexRoute:
    def test_reindexes_the_corpus_and_records_an_audit_event(self, tmp_path):
        # arrange
        corpus = FakeCorpus([make_skill("skill-a"), make_skill("skill-b")])
        client, deps = _client_and_deps(tmp_path, pipeline=FakePipeline(), corpus=corpus)

        # act
        response = client.post("/reindex", headers=_auth())

        # assert
        assert response.status_code == 200
        assert response.json() == {"indexed": 2}
        events = [
            json.loads(line)
            for line in (tmp_path / "audit.jsonl").read_text().splitlines()
        ]
        assert any(event["event_type"] == "reindex" for event in events)

    def test_pipeline_failure_returns_typed_envelope_as_503(self, tmp_path):
        # arrange
        class FailingPipeline(FakePipeline):
            async def index_corpus(self, artifacts):
                raise Errors.stack_unavailable("redis", "connection refused")

        client, _ = _client_and_deps(
            tmp_path, pipeline=FailingPipeline(), corpus=FakeCorpus([])
        )

        # act
        response = client.post("/reindex", headers=_auth())

        # assert
        assert response.status_code == 503
        assert response.json()["error"] == Errors.stack_unavailable("redis", "x").code

    def test_missing_bearer_token_is_rejected(self, tmp_path):
        # arrange
        client, _ = _client_and_deps(tmp_path, pipeline=FakePipeline(), corpus=FakeCorpus([]))

        # act
        response = client.post("/reindex")

        # assert
        assert response.status_code == 401
