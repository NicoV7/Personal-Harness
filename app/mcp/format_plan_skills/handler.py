"""format_plan_skills — render the plan's '## Skill Audit' section.

The server cannot write ~/.claude/plans (Docker boundary), so this tool
returns paste-ready markdown the planning agent inserts into the plan:
the consulted-skills table with real retrieval provenance, a proposal
slot, and the orchestrator instruction pointing subagents at
get_plan_skills. The rendered section always spans >= 5 lines and carries
a proposal line, satisfying the external ExitPlanMode audit gate.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.hooks.plan_cache import PlanCacheEntry
from app.mcp.format_plan_skills.schema import FormatPlanSkillsInput

NAME = "format_plan_skills"
DESCRIPTION = (
    "Render a paste-ready '## Skill Audit' markdown section for a plan from "
    "the plan-skill cache: which skills matched, why (plan section + score), "
    "a proposal slot, and the get_plan_skills instruction for orchestrators. "
    "Insert the returned markdown as the plan's last section."
)


async def handle(
    input: FormatPlanSkillsInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    entry = (
        deps.plan_skills.get(input.plan_path)
        if input.plan_path
        else deps.plan_skills.latest()
    )
    if entry is None:
        raise Errors.plan_cache_miss(input.plan_path)
    deps.audit.record(
        "plan_format",
        {"plan_path": entry.plan_path, "skill_count": len(entry.matches)},
        meta,
    )
    return {
        "plan_path": entry.plan_path,
        "skill_count": len(entry.matches),
        "markdown": _render(entry),
    }


def _render(entry: PlanCacheEntry) -> str:
    matches = list(entry.matches.values())
    rows = [
        f"| {match.artifact.id} | {match.provenance} (hybrid {match.score:.2f}) |"
        for match in matches
    ] or ["| none matched | no corpus skill cleared the threshold for this plan |"]
    ids = ", ".join(match.artifact.id for match in matches) or "none"
    return "\n".join(
        (
            "## Skill Audit",
            "",
            "| Skill | Why matched |",
            "|---|---|",
            *rows,
            "",
            "Proposed skill: <planner: propose one New/Update skill here, or "
            "'none — existing corpus coverage suffices'>",
            "",
            "Orchestrators: instruct every subagent to call "
            "mcp__betterai__get_plan_skills before mutating files; these "
            "skills are cached server-side for this plan (cold-cache "
            f"skill_ids fallback: {ids}).",
        )
    )
