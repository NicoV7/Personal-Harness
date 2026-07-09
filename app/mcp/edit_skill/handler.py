"""edit_skill — validate, write markdown, then reindex (write-through).

Write order is file-first because the corpus markdown is the system of
record: if reindexing fails, the durable artifact survives on disk and
the raised error says exactly how to recover (`betterai index`). The
file is never rolled back on index failure — the derived stores catch
up, the record does not disappear. Render/validate/write live in
app/corpus/writer.py (shared with the ingest pipeline).
"""

from __future__ import annotations

from pathlib import Path

from app.corpus.schema import Artifact
from app.corpus.writer import (
    ARTIFACT_FILE_MODE,
    artifact_path,
    check_rule_sections,
    render_markdown,
    validate_artifact,
    write_artifact,
)
from app.deps import CallMeta, Deps, ProgressFn
from app.errors import BetterAIError, Errors
from app.mcp.edit_skill.schema import EditSkillInput

__all__ = ["NAME", "DESCRIPTION", "ARTIFACT_FILE_MODE", "handle"]

NAME = "edit_skill"
DESCRIPTION = (
    "Create or update a corpus rule or skill (the ONLY writable tool). "
    "Validates frontmatter and required rule sections, writes the markdown "
    "file into the chosen scope root, and reindexes it for retrieval."
)


async def handle(
    input: EditSkillInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    spec = input.artifact
    check_rule_sections(spec)
    root = _scope_root(deps, input.scope, spec.id)
    path = artifact_path(root, spec)
    rendered = render_markdown(spec)
    artifact = validate_artifact(spec, input.scope, path, rendered)
    write_artifact(path, rendered)
    await _reindex(deps, artifact, path)
    deps.audit.record(
        "skill_edited",
        {"id": spec.id, "path": str(path), "scope": input.scope, "indexed": True},
        meta,
    )
    return {"id": spec.id, "path": str(path), "indexed": True}


def _scope_root(deps: Deps, scope: str, artifact_id: str) -> str:
    if scope == "global":
        return deps.corpus.global_root
    if deps.corpus.repo_root is None:
        raise Errors.artifact_invalid(
            artifact_id, "scope 'repo' requested but no repo corpus root is configured"
        )
    return deps.corpus.repo_root


async def _reindex(deps: Deps, artifact: Artifact, path: Path) -> None:
    try:
        await deps.pipeline.index_artifact(artifact)
    except BetterAIError as exc:
        raise Errors.index_write_error(
            f"{artifact.id} was written to {path} but reindexing failed ({exc}); "
            "run `betterai index` to reindex",
            cause=exc,
        ) from exc
