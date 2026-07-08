"""list_skills: inventory rows, kind filter, audit line."""

from __future__ import annotations

from app.mcp.list_skills.handler import handle
from app.mcp.list_skills.schema import INPUT_MODEL


class TestListSkills:
    async def test_lists_both_kinds_with_inventory_fields(self, deps, meta):
        # arrange
        payload = INPUT_MODEL()
        # act
        out = await handle(payload, deps, meta)
        # assert
        rows = {row["id"]: row for row in out["artifacts"]}
        assert set(rows) == {
            "fail-loud-no-retries",
            "write-scoped-plan",
            "write-pytest-fixture",
        }
        rule = rows["fail-loud-no-retries"]
        assert rule == {
            "id": "fail-loud-no-retries",
            "artifact_type": "rule",
            "title": "Repo override",
            "category": "STANDARDS",
            "severity": "high",
            "forced": False,
            "scope": "repo",
        }

    async def test_kind_filter_returns_only_that_kind(self, deps, meta):
        # arrange
        payload = INPUT_MODEL(artifact_type="skill")
        # act
        out = await handle(payload, deps, meta)
        # assert
        assert all(row["artifact_type"] == "skill" for row in out["artifacts"])
        assert len(out["artifacts"]) == 2

    async def test_audit_list_event_written(self, deps, meta, read_audit):
        # arrange
        payload = INPUT_MODEL(artifact_type="rule")
        # act
        await handle(payload, deps, meta)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "list"
        assert event["payload"] == {"artifact_type": "rule", "count": 1}
        assert event["agent_session_id"] == "sess-main"
