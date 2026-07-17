"""/api/* UI routes: thin wrappers over MCP handlers, typed envelopes.

Same boundary conventions as the rest of the suite: real corpus markdown
under tmp_path, real audit JSONL, FakePipeline at the retrieval seam
(conftest `deps`). Auth is BearerAuthMiddleware's job and is exercised
elsewhere; these tests mount the routes bare like test_health_route.
"""

from __future__ import annotations

from pathlib import Path

from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.api.routes import api_routes


def _client(deps) -> TestClient:
    return TestClient(Starlette(routes=api_routes(deps)))


def test_skills_index_lists_inventory_rows(deps):
    # arrange
    client = _client(deps)

    # act
    body = client.get("/api/skills").json()

    # assert
    ids = {row["id"] for row in body["artifacts"]}
    assert {"fail-loud-no-retries", "write-scoped-plan", "write-pytest-fixture"} <= ids
    assert all("body" not in row for row in body["artifacts"])


def test_skills_index_filters_by_artifact_type(deps):
    # arrange
    client = _client(deps)

    # act
    body = client.get("/api/skills", params={"artifact_type": "rule"}).json()

    # assert
    assert {row["artifact_type"] for row in body["artifacts"]} == {"rule"}


def test_skill_detail_returns_full_body_without_touching_gate_state(deps):
    # arrange
    client = _client(deps)

    # act
    body = client.get("/api/skills/write-scoped-plan").json()

    # assert
    assert body["id"] == "write-scoped-plan"
    assert "Enumerate the files to touch" in body["body"]
    assert deps.store.session_count() == 0  # None session id => receipt no-op


def test_skill_detail_unknown_id_is_typed_404(deps):
    # act
    response = _client(deps).get("/api/skills/nope-not-here")

    # assert
    assert response.status_code == 404
    assert response.json()["error"] == "BAI-404"


def test_skill_raw_returns_markdown_source(deps):
    # act
    body = _client(deps).get("/api/skills/write-scoped-plan/raw").json()

    # assert
    assert body["id"] == "write-scoped-plan"
    assert body["markdown"].startswith("---\n")
    assert body["path"].endswith("write-scoped-plan.md")


def test_put_skill_writes_file_and_reindexes(deps, pipeline, read_audit):
    # arrange
    payload = {
        "artifact": {
            "id": "write-pytest-fixture",
            "artifact_type": "skill",
            "category": "testing",
            "title": "Write a pytest fixture (edited)",
            "when_to_use": "When adding tests",
            "body": "## Steps\n\n1. Arrange, act, assert. 2. Edited.\n",
        },
        "scope": "global",
    }

    # act
    body = _client(deps).put("/api/skills/write-pytest-fixture", json=payload).json()

    # assert
    assert body == {"id": "write-pytest-fixture", "path": body["path"], "indexed": True}
    assert [artifact.id for artifact in pipeline.indexed] == ["write-pytest-fixture"]
    refreshed = deps.corpus.find("write-pytest-fixture")
    assert refreshed.title == "Write a pytest fixture (edited)"
    assert any(
        event["event_type"] == "skill_edited"
        and event["subagent_class"] == "ui"
        and event["agent_session_id"] is None
        for event in read_audit()
    )


def test_put_skill_rejects_path_body_id_mismatch(deps):
    # arrange
    payload = {
        "artifact": {
            "id": "some-other-id",
            "artifact_type": "skill",
            "category": "testing",
            "title": "Mismatch",
            "body": "## Steps\n\n1. Nope.\n",
        },
        "scope": "global",
    }

    # act
    response = _client(deps).put("/api/skills/write-pytest-fixture", json=payload)

    # assert
    assert response.status_code == 422
    assert response.json()["error"] == "BAI-410"


def test_put_skill_invalid_body_is_bai_121_at_400(deps):
    # act
    response = _client(deps).put(
        "/api/skills/x-y", json={"artifact": {"id": "x-y"}, "scope": "global"}
    )

    # assert
    assert response.status_code == 400
    assert response.json()["error"] == "BAI-121"


def test_configure_settings_roundtrip(deps, write_markdown):
    # arrange: a skill declaring a settings_schema, on disk in the global root
    write_markdown(
        Path(deps.corpus.global_root) / "skills" / "editing" / "concise-comments.md",
        """
        id: concise-comments
        title: Concise comments
        category: editing
        when_to_use: Always
        settings_schema:
          level:
            type: enum
            description: Comment verbosity level
            default: "off"
            choices: ["off", "lines:2"]
        """,
        "## Steps\n\n1. Be brief.\n",
    )

    # act
    body = (
        _client(deps)
        .post("/api/skills/concise-comments/settings", json={"settings": {"level": "lines:2"}})
        .json()
    )

    # assert
    assert body == {"id": "concise-comments", "settings": {"level": "lines:2"}, "indexed": True}
    assert deps.corpus.find("concise-comments").settings == {"level": "lines:2"}
