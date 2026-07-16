"""Input schema for format_plan_skills (Skill Audit section rendering)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class FormatPlanSkillsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_path: str | None = Field(
        default=None,
        description=(
            "Plan file path as named in the plan or hook payloads; defaults "
            "to the most recently captured plan."
        ),
    )


INPUT_MODEL = FormatPlanSkillsInput
