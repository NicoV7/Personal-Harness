"""POST /sync ops route: 200 summary on success, typed envelope on failure."""

from __future__ import annotations

import httpx
from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.server import ops_routes
from tests.sync.unit.test_skills_sync import SKILL_MD, _serving, _sync_deps, _targz


def _client(deps) -> TestClient:
    return TestClient(Starlette(routes=ops_routes(deps)))


def test_sync_route_returns_summary(tmp_path):
    # arrange
    transport, _ = _serving(_targz({"skills/testing/synced-skill.md": SKILL_MD}))
    deps = _sync_deps(tmp_path, transport=transport)

    # act
    response = _client(deps).post("/sync")

    # assert
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["written"] == 1


def test_sync_route_returns_typed_envelope_on_failure(tmp_path):
    # arrange
    deps = _sync_deps(
        tmp_path, transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )

    # act
    response = _client(deps).post("/sync")

    # assert
    assert response.status_code == 502
    assert response.json()["error"] == "BAI-610"
