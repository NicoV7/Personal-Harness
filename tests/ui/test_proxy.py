"""UI server proxy: bearer injection, prefix mapping, typed failure.

The upstream is a fake Starlette app reached through httpx.ASGITransport
(httpx.AsyncClient is monkeypatched at the module seam) — no sockets, no
live server, and the assertion surface is exactly what the container
would see: path + Authorization header.
"""

from __future__ import annotations

import json

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.ui.server import build_ui_app


def _upstream() -> Starlette:
    async def echo(request):
        return JSONResponse(
            {
                "path": request.url.path,
                "auth": request.headers.get("authorization"),
                "body": (await request.body()).decode() or None,
            }
        )

    return Starlette(routes=[Route("/{path:path}", echo, methods=["GET", "POST", "PUT", "DELETE"])])


@pytest.fixture
def ui_client(tmp_path, monkeypatch) -> TestClient:
    root = tmp_path / ".betterai"
    root.mkdir()
    (root / "token").write_text("tok-secret\n")
    (root / "audit").mkdir()

    transport = httpx.ASGITransport(app=_upstream())
    real_client = httpx.AsyncClient

    def patched_client(**kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched_client)
    return TestClient(build_ui_app(str(tmp_path), upstream="http://upstream.test"))


def test_proxy_injects_bearer_token_and_forwards_path(ui_client):
    # act
    body = ui_client.get("/api/skills").json()

    # assert
    assert body["path"] == "/api/skills"
    assert body["auth"] == "Bearer tok-secret"


def test_proxy_maps_server_prefix_to_operator_routes(ui_client):
    # act
    body = ui_client.post("/api/server/reindex", content=b"{}").json()

    # assert: /api/server/reindex reaches the container as /reindex
    assert body["path"] == "/reindex"
    assert body["auth"] == "Bearer tok-secret"


def test_proxy_forwards_json_bodies(ui_client):
    # act
    payload = {"artifact": {"id": "x-y"}, "scope": "global"}
    body = ui_client.put("/api/skills/x-y", json=payload).json()

    # assert
    assert json.loads(body["body"]) == payload


def test_missing_token_is_typed_503(tmp_path):
    # arrange: HOME without a token file
    (tmp_path / ".betterai").mkdir()
    client = TestClient(build_ui_app(str(tmp_path)))

    # act
    response = client.get("/api/skills")

    # assert
    assert response.status_code == 503
    assert response.json()["error"] == "BAI-210"


def test_unreachable_upstream_is_bai_601(tmp_path, monkeypatch):
    # arrange
    root = tmp_path / ".betterai"
    root.mkdir()
    (root / "token").write_text("tok\n")

    class ExplodingClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def request(self, *args, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", ExplodingClient)
    client = TestClient(build_ui_app(str(tmp_path)))

    # act
    response = client.get("/api/skills")

    # assert: typed envelope naming the recovery path, never a blank 500
    assert response.status_code == 503
    assert response.json()["error"] == "BAI-601"
    assert "betterai start" in response.json()["message"]


def test_local_routes_win_over_proxy(tmp_path, monkeypatch):
    # arrange: /api/local/* must be served host-side, not proxied
    root = tmp_path / ".betterai"
    (root / "audit").mkdir(parents=True)
    (root / "token").write_text("tok\n")
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: pytest.fail("local route was proxied")
    )
    client = TestClient(build_ui_app(str(tmp_path)))

    # act
    body = client.get("/api/local/audit").json()

    # assert
    assert body == {"events": [], "total": 0}
