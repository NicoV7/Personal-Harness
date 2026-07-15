"""/health: liveness plus non-secret counters; infra probes never 500 it."""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.errors import Errors
from app.server import health_route
from tests.mcp.gate_helpers import FakePipeline, make_deps


def _client(deps) -> TestClient:
    return TestClient(Starlette(routes=[health_route(deps)]))


def test_health_reports_counters(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    deps.store.set("s1", "ns", "k", 1)

    # act
    body = _client(deps).get("/health").json()

    # assert
    assert body["status"] == "ok"
    assert body["service"] == "betterai"
    assert body["sessions"] == 1
    assert body["rss_kb"] > 0
    assert body["corpus_artifacts"] == 0
    assert body["index"] == {"ok": True}


def test_health_degrades_to_null_on_infra_failure(tmp_path):
    # arrange
    deps = make_deps(
        tmp_path,
        pipeline=FakePipeline(error=Errors.stack_unavailable("redis", "down")),
    )

    # act
    response = _client(deps).get("/health")

    # assert
    assert response.status_code == 200
    assert response.json()["index"] is None
    assert response.json()["status"] == "ok"
