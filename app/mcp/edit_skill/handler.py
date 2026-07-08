"""edit_skill — validate, write markdown, then reindex (write-through).

Write order is file-first because the corpus markdown is the system of
record: if reindexing fails, the durable artifact survives on disk and
the raised error says exactly how to recover (`betterai index`). The
file is never rolled back on index failure — the derived stores catch
up, the record does not disappear.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import yaml
from pydantic import ValidationError

from app.corpus.schema import Artifact, missing_rule_sections
from app.deps import CallMeta, Deps, ProgressFn
from app.errors import BetterAIError, Errors
from app.mcp.edit_skill.schema import ArtifactInput, EditSkillInput

NAME = "edit_skill"
DESCRIPTION = (
    "Create or update a corpus rule or skill (the ONLY writable tool). "
    "Validates frontmatter and required rule sections, writes the markdown "
    "file into the chosen scope root, and reindexes it for retrieval."
)

ARTIFACT_FILE_MODE = 0o640


async def handle(
    input: EditSkillInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    spec = input.artifact
    _check_rule_sections(spec)
    root = _scope_root(deps, input.scope, spec.id)
    path = Path(root) / f"{spec.artifact_type}s" / spec.category / f"{spec.id}.md"
    rendered = _render_markdown(spec)
    artifact = _validate(spec, input.scope, path, rendered)
    _write_file(path, rendered)
    await _reindex(deps, artifact, path)
    deps.audit.record(
        "skill_edited",
        {"id": spec.id, "path": str(path), "scope": input.scope, "indexed": True},
        meta,
    )
    return {"id": spec.id, "path": str(path), "indexed": True}


def _check_rule_sections(spec: ArtifactInput) -> None:
    if spec.artifact_type != "rule":
        return
    missing = missing_rule_sections(spec.body)
    if missing:
        raise Errors.artifact_invalid(
            spec.id, f"rule body missing required sections: {', '.join(missing)}"
        )


def _scope_root(deps: Deps, scope: str, artifact_id: str) -> str:
    if scope == "global":
        return deps.corpus.global_root
    if deps.corpus.repo_root is None:
        raise Errors.artifact_invalid(
            artifact_id, "scope 'repo' requested but no repo corpus root is configured"
        )
    return deps.corpus.repo_root


def _render_markdown(spec: ArtifactInput) -> str:
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
    rendered = yaml.safe_dump(
        frontmatter, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).strip()
    return f"---\n{rendered}\n---\n\n{spec.body.rstrip()}\n"


def _validate(spec: ArtifactInput, scope: str, path: Path, rendered: str) -> Artifact:
    """Belt-and-braces against the corpus schema: what edit_skill writes
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


def _write_file(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered, encoding="utf-8")
    os.chmod(path, ARTIFACT_FILE_MODE)


async def _reindex(deps: Deps, artifact: Artifact, path: Path) -> None:
    try:
        await deps.pipeline.index_artifact(artifact)
    except BetterAIError as exc:
        raise Errors.index_write_error(
            f"{artifact.id} was written to {path} but reindexing failed ({exc}); "
            "run `betterai index` to reindex",
            cause=exc,
        ) from exc
