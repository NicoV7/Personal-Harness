"""Input schema for configure_skill (per-skill settings updates)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

__all__ = ["ConfigureSkillInput", "INPUT_MODEL"]


class ConfigureSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(min_length=1, description="Id of the artifact to configure.")
    settings: dict[str, str] = Field(
        description=(
            "Option values to set, e.g. {'level': 'lines:2'}. Every key must be "
            "declared in the artifact's settings_schema; values are validated "
            "against the declared option type/choices/pattern."
        )
    )


INPUT_MODEL = ConfigureSkillInput
