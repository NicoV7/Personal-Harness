"""Corpus artifact frontmatter models.

Rules and skills are unified into one `Artifact` runtime type (kind
discriminates) because retrieval, gating, and the MCP tool surface treat
them identically; memories are a separate model parsed ONLY for the
`export-memories` migration path (memories are deprecated in v0.2).
Validation lives here so the reader, edit_skill, and the indexer all
enforce the exact same shape instead of drifting apart.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

KEBAB_ID_PATTERN = r"^[a-z0-9][a-z0-9-]*[a-z0-9]$"

# Body sections every rule must carry (rules/_meta/schema.md contract).
# edit_skill rejects rule writes missing any of these, listing the gaps.
REQUIRED_RULE_SECTIONS = (
    "## What this rule says",
    "## Why it matters",
    "## When this applies",
    "## What good looks like",
    "## Anti-patterns",
)

Scope = Literal["global", "repo"]
ArtifactType = Literal["rule", "skill"]


class AppliesWhen(BaseModel):
    """Activation hints: any match pulls the artifact into context."""

    model_config = ConfigDict(extra="ignore")

    paths: list[str] | None = None
    symbols: list[str] | None = None
    intents: list[str] | None = None


class Check(BaseModel):
    """Optional machine check attached to a rule (used by `betterai check`)."""

    model_config = ConfigDict(extra="ignore")

    artifact_type: Literal["regex", "ast-grep"]
    pattern: str


class Artifact(BaseModel):
    """One corpus rule or skill, frontmatter + body, scope-stamped.

    Extra frontmatter keys are ignored (not rejected) so legacy fields
    from the TS corpus (steps_count, fire_count, ...) keep parsing while
    the Python schema stays lean.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(pattern=KEBAB_ID_PATTERN)
    artifact_type: ArtifactType
    title: str = Field(min_length=1)
    category: str = Field(min_length=1)
    severity: Literal["low", "medium", "high"] | None = None
    domain: str | None = None
    when_to_use: str | None = None
    forced: bool = False
    applies_when: AppliesWhen | None = None
    check: Check | None = None
    created: str | None = None
    scope: Scope = "global"
    source_path: str | None = None
    content_hash: str | None = None
    body: str = ""


class Memory(BaseModel):
    """Deprecated memory artifact — parsed ONLY for `export-memories`.

    Lenient on purpose: exports must not fail loud over legacy field
    drift in files that are on their way out of the system.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    date: str | None = None
    project: str | None = None
    artifact_type: str | None = None
    context_keywords: list[str] = Field(default_factory=list)
    durability: str | None = None
    auto_captured: bool = False
    applies_to_future_intents: list[str] | None = None
    related_rules: list[str] | None = None
    related_memories: list[str] | None = None
    expires_on: str | None = None
    scope: Scope = "global"
    source_path: str | None = None
    body: str = ""


def missing_rule_sections(body: str) -> list[str]:
    """Which of the required rule sections are absent from a body."""
    return [section for section in REQUIRED_RULE_SECTIONS if section not in body]
