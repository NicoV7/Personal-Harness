"""configure_skill — validate values against a skill's declared
settings_schema, update ONLY the `settings` frontmatter key, reindex.

The update round-trips the file's own frontmatter mapping (not the
ArtifactInput shape) so keys the write model does not carry — check,
related, created — survive configuration. File-first write-through with
the shared reindex recovery; one attempt, fail loud.
"""

from __future__ import annotations

from pathlib import Path

from app.corpus.reader import parse_artifact_text, split_frontmatter
from app.corpus.schema import invalid_setting
from app.corpus.writer import render_raw_markdown, reindex_artifact, write_artifact
from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.mcp.configure_skill.schema import ConfigureSkillInput

__all__ = ["NAME", "DESCRIPTION", "handle"]

NAME = "configure_skill"
DESCRIPTION = (
    "Set option values on a skill that declares settings_schema (e.g. the "
    "concise-comments level). Values are validated against the declared "
    "options, persisted into the artifact's frontmatter, and reindexed."
)


async def handle(
    input: ConfigureSkillInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    if not input.settings:
        raise Errors.artifact_invalid(input.skill_id, "no settings provided")
    artifact = deps.corpus.find(input.skill_id)
    if artifact is None:
        raise Errors.artifact_not_found(input.skill_id)
    if not artifact.settings_schema:
        raise Errors.artifact_invalid(
            input.skill_id, "declares no settings_schema; nothing to configure"
        )
    for key, value in input.settings.items():
        if problem := invalid_setting(artifact.settings_schema, key, value):
            raise Errors.artifact_invalid(input.skill_id, problem)
    path = Path(artifact.source_path)
    frontmatter, body = split_frontmatter(path, path.read_text(encoding="utf-8"))
    merged = {**(frontmatter.get("settings") or {}), **input.settings}
    frontmatter["settings"] = merged
    updated = render_raw_markdown(frontmatter, body)
    refreshed = parse_artifact_text(
        updated,
        artifact_type=artifact.artifact_type,
        scope=artifact.scope,
        source_path=str(path),
    )
    write_artifact(path, updated)
    await reindex_artifact(deps, refreshed, path)
    deps.audit.record(
        "skill_configured",
        {"id": input.skill_id, "keys": sorted(input.settings), "settings": merged},
        meta,
    )
    return {"id": input.skill_id, "settings": merged, "indexed": True}
