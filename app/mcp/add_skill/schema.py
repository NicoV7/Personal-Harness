"""Input schema for add_skill (raw markdown file -> indexed artifact)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

__all__ = ["AddSkillInput", "INPUT_MODEL"]


class AddSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    markdown: str = Field(
        min_length=1,
        description=(
            "Full markdown file content: YAML frontmatter block + body. Facets "
            "missing from the frontmatter (artifact_type, category, intents, ...) "
            "are filled by one classification call; the body is never rewritten."
        ),
    )
    forced: bool | None = Field(
        default=None,
        description=(
            "Override the artifact's forced flag: true injects it into every "
            "retrieval. Omit to keep the frontmatter's own value."
        ),
    )


INPUT_MODEL = AddSkillInput
