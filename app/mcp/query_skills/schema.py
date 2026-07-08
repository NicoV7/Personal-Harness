"""Input schema for query_skills (THE retrieval entry point)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

# Hard ceiling regardless of settings: more than 32 artifacts in one
# retrieval is context bloat, not signal.
MAX_TOP_K = 32


class QueryContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: str | None = Field(
        default=None,
        description="What the agent is about to do, in plain words.",
    )
    file_paths: list[str] | None = Field(
        default=None,
        description="Files the agent intends to read or edit.",
    )
    symbols: list[str] | None = Field(
        default=None,
        description="Symbols (functions, classes) in scope for the task.",
    )


class QuerySkillsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: QueryContext
    aspects: list[str] | None = Field(
        default=None,
        description=(
            "One entry per sub-problem of the task (e.g. 'networking error "
            "handling', 'write feature tests'). Each aspect runs its own "
            "hybrid query so phase-specific skills are found reliably."
        ),
    )
    domain: str | None = Field(
        default=None,
        description="Optional facet filter, e.g. 'error-handling' or 'testing'.",
    )
    artifact_type: str | None = Field(
        default=None,
        description="Optional filter: 'rule' or 'skill'; omit for both.",
    )
    top_k: int | None = Field(
        default=None,
        ge=1,
        le=MAX_TOP_K,
        description=(
            "OPTIONAL cap. Omit to receive every artifact above the "
            "similarity threshold with a keyword match — the intended mode, "
            "so all genuinely relevant skills can be read in full."
        ),
    )


INPUT_MODEL = QuerySkillsInput
