"""get_skill: full body, read-receipt transition, BAI-404, audit line."""

from __future__ import annotations

import pytest

from app.errors import ArtifactNotFoundError
from app.mcp.get_skill.handler import handle
from app.mcp.get_skill.schema import INPUT_MODEL


class TestGetSkill:
    async def test_returns_full_artifact_including_body(self, deps, meta):
        # arrange
        payload = INPUT_MODEL(skill_id="write-scoped-plan")
        # act
        out = await handle(payload, deps, meta)
        # assert
        assert out["id"] == "write-scoped-plan"
        assert out["artifact_type"] == "skill"
        assert "## Steps" in out["body"]
        assert out["forced"] is True

    async def test_any_kind_lookup_serves_rules_too(self, deps, meta):
        # arrange
        payload = INPUT_MODEL(skill_id="fail-loud-no-retries")
        # act
        out = await handle(payload, deps, meta)
        # assert (repo override wins per conflict-resolution)
        assert out["artifact_type"] == "rule"
        assert out["scope"] == "repo"

    async def test_read_receipt_moves_id_from_required_to_read(self, deps, meta):
        # arrange
        deps.store.set(
            "sess-main", "read_gate", "required", ["write-scoped-plan", "other-skill"]
        )
        # act
        await handle(INPUT_MODEL(skill_id="write-scoped-plan"), deps, meta)
        # assert
        assert deps.store.get("sess-main", "read_gate", "required") == ["other-skill"]
        assert deps.store.get("sess-main", "read_gate", "read") == ["write-scoped-plan"]

    async def test_unknown_id_raises_bai_404(self, deps, meta):
        # arrange
        payload = INPUT_MODEL(skill_id="not-a-real-skill")
        # act
        with pytest.raises(ArtifactNotFoundError) as excinfo:
            await handle(payload, deps, meta)
        # assert
        assert excinfo.value.code == "BAI-404"

    async def test_audit_skill_read_event_written(self, deps, meta, read_audit):
        # arrange
        payload = INPUT_MODEL(skill_id="write-pytest-fixture")
        # act
        await handle(payload, deps, meta)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "skill_read"
        assert event["payload"] == {
            "id": "write-pytest-fixture",
            "artifact_type": "skill",
            "scope": "global",
        }
        assert event["agent_session_id"] == "sess-main"
