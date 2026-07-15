"""Hook route round-trips: JSON shapes must match src/hooks/routes.ts.

Fakes sit only at the cross-module seams (pipeline, corpus); the session
store, gate chain, and audit log are real. Hook endpoints must always
answer 200 — a 5xx would silently disable gating on the client side.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.errors import Errors
from app.hooks.routes import hook_routes
from app.mcp.read_gate import store as read_store
from app.mcp.retrieval_receipt_gate import store as receipt_store
from tests.mcp.gate_helpers import (
    FakeCorpus,
    FakePipeline,
    FakeScored,
    audit_events,
    make_deps,
    make_settings,
    make_skill,
)

SESSION = "sess-hooks"


def _client_and_deps(tmp_path, *, pipeline=None, corpus=None, settings=None):
    deps = make_deps(
        tmp_path,
        settings=settings or make_settings(tmp_path),
        pipeline=pipeline,
        corpus=corpus,
    )
    app = Starlette(routes=hook_routes(deps))
    return TestClient(app), deps


def _matching_pipeline():
    return FakePipeline(results=[FakeScored(make_skill("rename-safely"))])


def test_prompt_serves_required_skill_bodies_and_marks_receipts(tmp_path):
    # arrange
    client, _ = _client_and_deps(tmp_path, pipeline=_matching_pipeline())

    # act
    response = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    )

    # assert: bodies ride the response and receipts are marked at delivery
    assert response.status_code == 200
    body = response.json()
    assert body["required_skill_ids"] == ["rename-safely"]
    assert body["missing_skill_ids"] == []
    assert body["skills"][0]["id"] == "rename-safely"
    context = body["hookSpecificOutput"]["additionalContext"]
    assert "## BetterAI required skill: rename-safely" in context
    assert body["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"


def test_pre_tool_use_denies_mutations_only_while_unread(tmp_path):
    # arrange: unread required state (as after a retrieval failure)
    client, deps = _client_and_deps(tmp_path, pipeline=_matching_pipeline())
    read_store.set_required(deps.store, SESSION, ["rename-safely"])
    receipt_store.mark_retrieved(deps.store, SESSION)

    # act
    blocked = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "Edit"}
    ).json()
    read_only = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "Read"}
    ).json()
    loader = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "ToolSearch"}
    ).json()
    read_store.mark_read(deps.store, SESSION, "rename-safely")
    allowed = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "Edit"}
    ).json()

    # assert
    assert blocked["block"] is True
    assert blocked["permissionDecision"] == "deny"
    assert blocked["missing_skill_ids"] == ["rename-safely"]
    assert "rename-safely" in blocked["hookSpecificOutput"]["permissionDecisionReason"]
    assert read_only["block"] is False
    assert loader["block"] is False
    assert allowed["block"] is False
    assert allowed["missing_skill_ids"] == []


def test_stop_blocks_exactly_once_then_passes(tmp_path):
    # arrange: unread required state (serving marks receipts, so force it)
    client, deps = _client_and_deps(tmp_path, pipeline=_matching_pipeline())
    read_store.set_required(deps.store, SESSION, ["rename-safely"])

    # act
    first = client.post("/hooks/stop", json={"session_id": SESSION}).json()
    second = client.post("/hooks/stop", json={"session_id": SESSION}).json()

    # assert
    assert first["block"] is True
    assert first["decision"] == "block"
    assert "rename-safely" in first["reason"]
    assert second["block"] is False


def test_non_matching_prompt_resets_required_and_unblocks(tmp_path):
    # arrange
    pipeline = _matching_pipeline()
    client, _ = _client_and_deps(tmp_path, pipeline=pipeline)
    client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    )

    # act: the next prompt matches nothing, so the new turn must reset
    pipeline._results = []
    no_match = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "compute the twentieth fibonacci number"},
    ).json()
    allowed = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "Read"}
    ).json()

    # assert
    assert no_match["required_skill_ids"] == []
    assert "continue normally" in no_match["hookSpecificOutput"]["additionalContext"]
    assert allowed["block"] is False


def test_retrieval_failure_releases_gating_with_visible_bai601_context(tmp_path):
    # arrange: a failed serve must not deadlock the turn (BAI-701 post-mortem) —
    # MCP-side receipts cannot reach the hook session id, so there is no remedy
    failing = FakePipeline(error=Errors.stack_unavailable("redis", "connection refused"))
    client, _ = _client_and_deps(tmp_path, pipeline=failing)

    # act
    prompt = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    )
    write_after_failure = client.post(
        "/hooks/pre-tool-use",
        json={
            "session_id": SESSION,
            "tool_name": "Write",
            "tool_input": {"file_path": "/repo/app/a.py"},
        },
    ).json()

    # assert: hook stays 200, failure is loud in context, gating is released
    assert prompt.status_code == 200
    body = prompt.json()
    context = body["hookSpecificOutput"]["additionalContext"]
    assert "BAI-601" in context
    assert "betterai start" in context
    assert "released" in context
    assert body["missing_skill_ids"] == []
    assert write_after_failure["block"] is False


def test_never_served_session_edit_allowed_with_wiring_warning(tmp_path):
    # arrange: broken client wiring — no prompt POST ever for this session
    client, deps = _client_and_deps(tmp_path, pipeline=_matching_pipeline())

    # act
    body = client.post(
        "/hooks/pre-tool-use", json={"session_id": "never-served", "tool_name": "Edit"}
    ).json()

    # assert
    assert body["block"] is False
    assert "hook wiring" in body["hookSpecificOutput"]["additionalContext"]
    assert any(e["event_type"] == "gate_bypass_no_evidence" for e in audit_events(deps))


def test_prompt_serve_is_audited_with_session_id(tmp_path):
    # arrange
    client, deps = _client_and_deps(tmp_path, pipeline=_matching_pipeline())

    # act
    client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    )

    # assert
    serve = [e for e in audit_events(deps) if e["event_type"] == "prompt_serve"]
    assert serve and serve[-1]["agent_session_id"] == SESSION
    assert serve[-1]["payload"]["required"] == ["rename-safely"]


def _sync_marker(settings, state: dict) -> None:
    marker = Path(settings.corpus_root) / "_meta" / "skills-sync.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(state), encoding="utf-8")


def test_prompt_reports_sync_status_line(tmp_path):
    # arrange: fresh marker so the line is deterministic (no network)
    settings = make_settings(tmp_path, skills_repo_url="https://github.com/test/skills")
    _sync_marker(settings, {"ts": time.time(), "etag": None, "status": "ok"})
    client, _ = _client_and_deps(
        tmp_path, pipeline=_matching_pipeline(), settings=settings
    )

    # act
    body = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    ).json()

    # assert
    context = body["hookSpecificOutput"]["additionalContext"]
    assert "BetterAI skills sync: last refresh" in context


def test_sync_failure_only_warns_and_never_blocks(tmp_path):
    # arrange
    settings = make_settings(tmp_path, skills_repo_url="https://github.com/test/skills")
    _sync_marker(
        settings,
        {"ts": time.time(), "etag": None, "status": "failed", "error": "HTTP 500"},
    )
    client, _ = _client_and_deps(
        tmp_path, pipeline=_matching_pipeline(), settings=settings
    )

    # act
    prompt = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    ).json()
    write = client.post(
        "/hooks/pre-tool-use", json={"session_id": SESSION, "tool_name": "Write"}
    ).json()

    # assert
    context = prompt["hookSpecificOutput"]["additionalContext"]
    assert "skills sync FAILED [BAI-610]" in context
    assert write["block"] is False


def test_forced_skills_are_injected_regardless_of_retrieval_score(tmp_path):
    # arrange
    corpus = FakeCorpus([make_skill("write-scoped-plan", forced=True)])
    client, _ = _client_and_deps(
        tmp_path, pipeline=FakePipeline(results=[]), corpus=corpus
    )

    # act
    body = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "add a feature"},
    ).json()

    # assert
    assert body["required_skill_ids"] == ["write-scoped-plan"]


def test_edit_incrementally_forced_skill_skipped_when_granularity_none(tmp_path):
    # arrange
    corpus = FakeCorpus([make_skill("edit-incrementally", forced=True)])
    settings = make_settings(tmp_path, edit_granularity="none")
    client, _ = _client_and_deps(
        tmp_path, pipeline=FakePipeline(results=[]), corpus=corpus, settings=settings
    )

    # act
    body = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "add a feature"},
    ).json()

    # assert
    assert body["required_skill_ids"] == []


def test_receipt_from_prompt_retrieval_allows_mutating_tools(tmp_path):
    # arrange
    client, _ = _client_and_deps(tmp_path, pipeline=FakePipeline(results=[]))
    client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "small tweak"},
    )

    # act
    decision = client.post(
        "/hooks/pre-tool-use",
        json={
            "session_id": SESSION,
            "tool_name": "Write",
            "tool_input": {"file_path": "/repo/app/a.py"},
        },
    ).json()

    # assert
    assert decision["block"] is False


def test_post_tool_use_carries_plan_manifest_warning_context(tmp_path):
    # arrange
    client, _ = _client_and_deps(tmp_path, pipeline=FakePipeline(results=[]))
    client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "plan the work"},
    )

    # act
    body = client.post(
        "/hooks/post-tool-use",
        json={
            "session_id": SESSION,
            "tool_name": "Write",
            "tool_input": {
                "file_path": "/repo/feature.plan.md",
                "content": "## Files to touch\n- app/a.py — run\n",
            },
            "tool_response": {},
        },
    ).json()

    # assert
    assert body["ok"] is True
    assert "captured" in body["hookSpecificOutput"]["additionalContext"]


def test_session_end_reports_cleared_and_resets_state(tmp_path):
    # arrange
    client, deps = _client_and_deps(tmp_path, pipeline=_matching_pipeline())
    client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "rename a variable safely"},
    )

    # act
    body = client.post("/hooks/session-end", json={"session_id": SESSION}).json()

    # assert
    assert body == {"ok": True, "session_id": SESSION, "cleared": True}
    assert read_store.missing(deps.store, SESSION) == []


def test_malformed_body_and_missing_session_never_500(tmp_path):
    # arrange
    client, _ = _client_and_deps(tmp_path, pipeline=FakePipeline(results=[]))

    # act
    garbage = client.post(
        "/hooks/pre-tool-use",
        content=b"not json",
        headers={"content-type": "application/json"},
    )
    no_session = client.post("/hooks/stop", json={})

    # assert
    assert garbage.status_code == 200
    assert garbage.json()["block"] is False
    assert no_session.status_code == 200
    assert no_session.json()["block"] is False
