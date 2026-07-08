"""Input schema for edit_skill (the ONLY writable tool)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.corpus.schema import KEBAB_ID_PATTERN


class AppliesWhenInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    paths: list[str] | None = None
    symbols: list[str] | None = None
    intents: list[str] | None = None


class ArtifactInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=KEBAB_ID_PATTERN, description="Kebab-case artifact id.")
    artifact_type: Literal["rule", "skill"]
    category: str = Field(min_length=1, description="Category directory the file lives under.")
    title: str = Field(min_length=1)
    severity: Literal["low", "medium", "high"] | None = None
    domain: str | None = None
    applies_when: AppliesWhenInput | None = None
    forced: bool = False
    when_to_use: str | None = None
    body: str = Field(
        min_length=1,
        description=(
            "Markdown body. Rules must contain the sections: '## What this rule "
            "says', '## Why it matters', '## When this applies', '## What good "
            "looks like', '## Anti-patterns'."
        ),
    )


class EditSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact: ArtifactInput
    scope: Literal["global", "repo"]


INPUT_MODEL = EditSkillInput
