"""Input schema for get_plan_skills (plan-scoped skill serving)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class GetPlanSkillsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_path: str | None = Field(
        default=None,
        description=(
            "Plan file path as named in the plan or hook payloads; defaults "
            "to the most recently captured plan."
        ),
    )
    skill_ids: list[str] | None = Field(
        default=None,
        description=(
            "Cold-cache fallback: skill ids from the plan's '## Skill Audit' "
            "table, served from the corpus when the cache is empty (server "
            "restart, eviction)."
        ),
    )


INPUT_MODEL = GetPlanSkillsInput
