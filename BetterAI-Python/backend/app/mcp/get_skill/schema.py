"""Input schema for get_skill (full-body read + read receipt)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.corpus.schema import KEBAB_ID_PATTERN


class GetSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(
        pattern=KEBAB_ID_PATTERN,
        description="Kebab-case artifact id as returned by query_skills or list_skills.",
    )


INPUT_MODEL = GetSkillInput
