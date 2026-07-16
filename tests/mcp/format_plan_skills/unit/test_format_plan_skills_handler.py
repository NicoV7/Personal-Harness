"""format_plan_skills: Skill Audit rendering, zero-match row, BAI-605."""

from __future__ import annotations

import pytest

from app.deps import CallMeta
from app.errors import PlanCacheMissError
from app.hooks.plan_cache import PlanSkillMatch, now_iso
from app.mcp.format_plan_skills.handler import handle
from app.mcp.format_plan_skills.schema import FormatPlanSkillsInput
from tests.mcp.gate_helpers import audit_events, make_deps, make_skill

PLAN = "/repo/.claude/plans/feature.md"
META = CallMeta(
    agent_session_id="sess-tool",
    parent_agent_session_id=None,
    subagent_class="main",
    tool_call_id="call-1",
)


async def test_renders_audit_table_with_provenance_and_instruction(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    match = PlanSkillMatch(
        artifact=make_skill("rename-safely"),
        score=0.9,
        provenance="plan section 'Approach'",
        served_at=now_iso(),
    )
    deps.plan_skills.upsert(PLAN, "hash-1", [match])

    # act
    result = await handle(FormatPlanSkillsInput(), deps, META)

    # assert: paste-ready section satisfying the ExitPlanMode audit gate
    markdown = result["markdown"]
    assert markdown.startswith("## Skill Audit")
    assert "| Skill | Why matched |" in markdown
    assert "| rename-safely | plan section 'Approach' (hybrid 0.90) |" in markdown
    assert "mcp__betterai__get_plan_skills" in markdown
    assert "Proposed skill:" in markdown
    assert len(markdown.splitlines()) >= 5
    assert result["plan_path"] == PLAN
    assert result["skill_count"] == 1
    fmt = [e for e in audit_events(deps) if e["event_type"] == "plan_format"][-1]
    assert fmt["payload"] == {"plan_path": PLAN, "skill_count": 1}


async def test_zero_match_plan_renders_placeholder_row(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    deps.plan_skills.upsert(PLAN, "hash-1", [])

    # act
    result = await handle(FormatPlanSkillsInput(plan_path=PLAN), deps, META)

    # assert: still a valid >=5-line section with a proposal slot
    markdown = result["markdown"]
    assert "| none matched |" in markdown
    assert "Proposed skill:" in markdown
    assert len(markdown.splitlines()) >= 5
    assert result["skill_count"] == 0


async def test_cold_cache_raises_bai_605(tmp_path):
    # arrange
    deps = make_deps(tmp_path)

    # act / assert
    with pytest.raises(PlanCacheMissError) as excinfo:
        await handle(FormatPlanSkillsInput(), deps, META)
    assert excinfo.value.code == "BAI-605"
