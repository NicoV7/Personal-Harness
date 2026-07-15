"""Corpus write path (render -> validate -> write), shared by the
edit_skill tool and the blog ingest pipeline.

Lifted from app/mcp/edit_skill/handler.py so ingestion does not reach
into the MCP layer. What this module writes must be exactly what
CorpusReader accepts back — validate_artifact enforces that round-trip
before any file touches disk.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import TYPE_CHECKING, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.corpus.schema import KEBAB_ID_PATTERN, Artifact, OptionSpec, missing_rule_sections
from app.errors import BetterAIError, Errors

if TYPE_CHECKING:
    from app.deps import Deps

ARTIFACT_FILE_MODE = 0o640


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
    source_url: str | None = Field(
        default=None, description="Provenance: URL the artifact was distilled from."
    )
    source_ref: str | None = Field(
        default=None, description="Provenance: chunk reference within source_url."
    )
    settings_schema: dict[str, OptionSpec] | None = Field(
        default=None,
        description="Configurable options this artifact declares (see configure_skill).",
    )
    settings: dict[str, str] | None = Field(
        default=None, description="Current values for declared settings_schema options."
    )
    body: str = Field(
        min_length=1,
        description=(
            "Markdown body. Rules must contain the sections: '## What this rule "
            "says', '## Why it matters', '## When this applies', '## What good "
            "looks like', '## Anti-patterns'."
        ),
    )


def check_rule_sections(spec: ArtifactInput) -> None:
    if spec.artifact_type != "rule":
        return
    missing = missing_rule_sections(spec.body)
    if missing:
        raise Errors.artifact_invalid(
            spec.id, f"rule body missing required sections: {', '.join(missing)}"
        )


def artifact_path(root: str, spec: ArtifactInput) -> Path:
    return Path(root) / f"{spec.artifact_type}s" / spec.category / f"{spec.id}.md"


def render_markdown(spec: ArtifactInput) -> str:
    frontmatter: dict = {
        "id": spec.id,
        "artifact_type": spec.artifact_type,
        "title": spec.title,
        "category": spec.category,
    }
    for key in ("severity", "domain", "when_to_use"):
        value = getattr(spec, key)
        if value is not None:
            frontmatter[key] = value
    frontmatter["forced"] = spec.forced
    if spec.applies_when is not None:
        hints = {key: value for key, value in spec.applies_when.model_dump().items() if value}
        if hints:
            frontmatter["applies_when"] = hints
    for key in ("source_url", "source_ref"):
        value = getattr(spec, key)
        if value is not None:
            frontmatter[key] = value
    if spec.settings_schema:
        frontmatter["settings_schema"] = {
            name: option.model_dump(by_alias=True, exclude_none=True)
            for name, option in spec.settings_schema.items()
        }
    if spec.settings:
        frontmatter["settings"] = dict(spec.settings)
    return render_raw_markdown(frontmatter, spec.body)


def render_raw_markdown(frontmatter: dict, body: str) -> str:
    """Frontmatter mapping + body -> full markdown text. Shared with
    configure_skill, which round-trips a file's own mapping to preserve
    keys the ArtifactInput shape does not model (check, related, ...)."""
    rendered = yaml.safe_dump(
        frontmatter, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).strip()
    return f"---\n{rendered}\n---\n\n{body.lstrip('\n').rstrip()}\n"


def validate_artifact(spec: ArtifactInput, scope: str, path: Path, rendered: str) -> Artifact:
    """Belt-and-braces against the corpus schema: what the writer emits
    must be exactly what CorpusReader will accept back."""
    data = spec.model_dump()
    data.update(
        scope=scope,
        source_path=str(path),
        content_hash=hashlib.sha256(rendered.encode("utf-8")).hexdigest(),
    )
    try:
        return Artifact(**data)
    except ValidationError as exc:
        issues = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise Errors.artifact_invalid(str(path), issues) from exc


def write_artifact(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered, encoding="utf-8")
    os.chmod(path, ARTIFACT_FILE_MODE)


async def reindex_artifact(deps: "Deps", artifact: Artifact, path: Path) -> None:
    """Write-through companion: the file already on disk is the system of
    record, so an index failure keeps it and the error says how to catch
    the derived stores up (one attempt, fail-loud-no-retries)."""
    try:
        await deps.pipeline.index_artifact(artifact)
    except BetterAIError as exc:
        raise Errors.index_write_error(
            f"{artifact.id} was written to {path} but reindexing failed ({exc}); "
            "run `betterai index` to reindex",
            cause=exc,
        ) from exc
