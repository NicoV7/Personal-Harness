"""Input schema for list_skills (inventory)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ListSkillsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_type: Literal["rule", "skill"] | None = Field(
        default=None,
        description="Optional filter; omit to list both rules and skills.",
    )


INPUT_MODEL = ListSkillsInput
