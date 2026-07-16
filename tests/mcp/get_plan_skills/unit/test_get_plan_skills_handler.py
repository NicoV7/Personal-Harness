"""get_plan_skills: warm serve, corpus fallback, BAI-605 miss, receipts."""

from __future__ import annotations

import pytest

from app.deps import CallMeta
from app.errors import PlanCacheMissError
from app.hooks.plan_cache import PlanSkillMatch, now_iso
from app.mcp.get_plan_skills.handler import handle
from app.mcp.get_plan_skills.schema import GetPlanSkillsInput
from tests.mcp.gate_helpers import FakeCorpus, audit_events, make_deps, make_skill

PLAN = "/repo/.claude/plans/feature.md"
META = CallMeta(
    agent_session_id="sess-tool",
    parent_agent_session_id=None,
    subagent_class="main",
    tool_call_id="call-1",
)


def _seed(deps, plan: str = PLAN, skill_id: str = "rename-safely") -> None:
    match = PlanSkillMatch(
        artifact=make_skill(skill_id),
        score=0.9,
        provenance="plan section 'Approach'",
        served_at=now_iso(),
    )
    deps.plan_skills.upsert(plan, "hash-1", [match])


async def test_serves_latest_cached_plan_by_default(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _seed(deps)

    # act
    result = await handle(GetPlanSkillsInput(), deps, META)

    # assert
    assert result["cache_hit"] is True
    assert result["plan_path"] == PLAN
    assert result["missing_skill_ids"] == []
    (skill,) = result["skills"]
    assert skill["id"] == "rename-safely"
    assert skill["provenance"] == "plan section 'Approach'"
    assert skill["score"] == 0.9


async def test_explicit_plan_path_wins_over_latest(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _seed(deps, plan=PLAN, skill_id="first-skill")
    _seed(deps, plan="/repo/.claude/plans/newer.md", skill_id="second-skill")

    # act
    result = await handle(GetPlanSkillsInput(plan_path=PLAN), deps, META)

    # assert
    assert result["plan_path"] == PLAN
    assert result["skills"][0]["id"] == "first-skill"


async def test_serve_records_read_receipts_and_audit(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _seed(deps)

    # act
    await handle(GetPlanSkillsInput(), deps, META)

    # assert: advisory receipt under the MCP session id + plan_serve audit
    read = deps.store.get("sess-tool", "read_gate", "read") or []
    assert "rename-safely" in read
    serve = [e for e in audit_events(deps) if e["event_type"] == "plan_serve"][-1]
    assert serve["payload"]["served"] == ["rename-safely"]
    assert serve["payload"]["cache_hit"] is True
    assert serve["payload"]["plan_path"] == PLAN


async def test_cold_cache_with_skill_ids_serves_from_corpus(tmp_path):
    # arrange
    deps = make_deps(tmp_path, corpus=FakeCorpus([make_skill("rename-safely")]))

    # act: a stale audit id must not fail the whole serve
    result = await handle(
        GetPlanSkillsInput(skill_ids=["rename-safely", "ghost-skill"]), deps, META
    )

    # assert
    assert result["cache_hit"] is False
    assert result["skills"][0]["id"] == "rename-safely"
    assert result["skills"][0]["provenance"] == "plan-audit-fallback"
    assert result["missing_skill_ids"] == ["ghost-skill"]


async def test_cold_cache_without_ids_raises_bai_605(tmp_path):
    # arrange
    deps = make_deps(tmp_path)

    # act / assert
    with pytest.raises(PlanCacheMissError) as excinfo:
        await handle(GetPlanSkillsInput(), deps, META)
    assert excinfo.value.code == "BAI-605"
    assert "Skill Audit" in str(excinfo.value)


async def test_captured_plan_with_zero_matches_serves_empty_not_miss(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    deps.plan_skills.upsert(PLAN, "hash-1", [])

    # act
    result = await handle(GetPlanSkillsInput(), deps, META)

    # assert
    assert result["cache_hit"] is True
    assert result["skills"] == []
    assert result["missing_skill_ids"] == []
