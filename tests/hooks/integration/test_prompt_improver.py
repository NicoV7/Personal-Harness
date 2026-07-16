"""Prompt improver + plan-mode surfacing through the hook routes.

Fakes at the seams only (pipeline, expander); session store, gates, and
route wiring are real. Test plan_glob is "*.plan.md" (gate_helpers).
"""

from __future__ import annotations

from types import SimpleNamespace

from starlette.applications import Starlette
from starlette.testclient import TestClient

import app.hooks.routes as routes_module
from app.hooks.routes import hook_routes
from app.mcp.read_gate import store as read_store
from app.retrieval.expand import Expansion
from tests.mcp.gate_helpers import (
    FakePipeline,
    FakeScored,
    audit_events,
    make_deps,
    make_settings,
    make_skill,
)

SESSION = "sess-improver"

PLAN_MARKDOWN = """# Plan: harden the http client

## Approach

Stop retrying; raise typed errors.

## Files to touch

- app/http_client.py — fetch_data
"""


def _client_and_deps(tmp_path, *, pipeline=None, improver_model="off"):
    settings = make_settings(tmp_path, prompt_improver_model=improver_model)
    deps = make_deps(tmp_path, settings=settings, pipeline=pipeline)
    app = Starlette(routes=hook_routes(deps))
    return TestClient(app), deps


class TestPromptImprover:
    def test_expanded_aspects_reach_the_retrieval_query(self, tmp_path, monkeypatch):
        # arrange
        pipeline = FakePipeline(results=[FakeScored(make_skill("no-retries"))])
        client, deps = _client_and_deps(
            tmp_path, pipeline=pipeline, improver_model="test/improver"
        )
        deps.chat = SimpleNamespace(get=lambda: object())
        monkeypatch.setattr(
            routes_module,
            "expand_prompt",
            lambda prompt, settings, chat: Expansion(
                aspects=["http error handling"], file_paths=["app/http_client.py"]
            ),
        )

        # act
        response = client.post(
            "/hooks/user-prompt-submit",
            json={"session_id": SESSION, "prompt": "fix the client"},
        )

        # assert
        assert response.status_code == 200
        assert pipeline.queries[-1]["aspects"] == ["http error handling"]
        context = response.json()["hookSpecificOutput"]["additionalContext"]
        assert "## BetterAI required skill: no-retries" in context

    def test_expansion_failure_warns_and_falls_back_to_raw_prompt(self, tmp_path):
        # arrange: improver enabled but no OpenRouter key file exists, so
        # building the chat client raises a typed error inside _expand.
        pipeline = FakePipeline(results=[FakeScored(make_skill("no-retries"))])
        client, deps = _client_and_deps(
            tmp_path, pipeline=pipeline, improver_model="test/improver"
        )

        # act
        body = client.post(
            "/hooks/user-prompt-submit",
            json={"session_id": SESSION, "prompt": "fix the client"},
        ).json()

        # assert: retrieval still ran (raw prompt), warning is visible
        assert pipeline.queries[-1]["intent"] == "fix the client"
        assert pipeline.queries[-1]["aspects"] is None
        context = body["hookSpecificOutput"]["additionalContext"]
        assert "prompt expansion FAILED" in context
        serve = [e for e in audit_events(deps) if e["event_type"] == "prompt_serve"][-1]
        assert serve["payload"]["required"] == ["no-retries"]

    def test_disabled_improver_never_expands(self, tmp_path):
        # arrange
        pipeline = FakePipeline()
        client, _ = _client_and_deps(tmp_path, pipeline=pipeline, improver_model="off")

        # act
        body = client.post(
            "/hooks/user-prompt-submit",
            json={"session_id": SESSION, "prompt": "fix the client"},
        ).json()

        # assert
        assert pipeline.queries[-1]["aspects"] is None
        assert "expansion" not in (body["hookSpecificOutput"]["additionalContext"] or "")


class TestPlanModeSurfacing:
    def test_plan_write_serves_matched_skills_inline(self, tmp_path):
        # arrange
        pipeline = FakePipeline(results=[FakeScored(make_skill("write-scoped-plan"))])
        client, deps = _client_and_deps(tmp_path, pipeline=pipeline)

        # act
        body = client.post(
            "/hooks/post-tool-use",
            json={
                "session_id": SESSION,
                "tool_name": "Write",
                "tool_input": {"file_path": "harden.plan.md", "content": PLAN_MARKDOWN},
            },
        ).json()

        # assert: served inline + receipted at delivery, nothing left unread
        assert read_store.missing(deps.store, SESSION) == []
        context = body["hookSpecificOutput"]["additionalContext"]
        assert "## BetterAI required skill: write-scoped-plan" in context
        # Full-plan retrieval: intent joins the h2 headings, and each
        # section rides as its own aspect (heading + body head).
        query = pipeline.queries[-1]
        assert query["intent"] == "Approach; Files to touch"
        assert any(aspect.startswith("Approach:") for aspect in query["aspects"])

    def test_non_plan_write_does_not_query(self, tmp_path):
        # arrange
        pipeline = FakePipeline()
        client, _ = _client_and_deps(tmp_path, pipeline=pipeline)

        # act
        client.post(
            "/hooks/post-tool-use",
            json={
                "session_id": SESSION,
                "tool_name": "Write",
                "tool_input": {"file_path": "app/http_client.py", "content": "code"},
            },
        )

        # assert
        assert pipeline.queries == []
