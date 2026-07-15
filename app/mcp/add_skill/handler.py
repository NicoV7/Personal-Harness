"""add_skill — raw markdown in: parse -> classify -> write -> index.

Each stage emits an MCP progress notification ("parsed", "classified",
"indexed") over the client's stream; "indexed" is the searchable-now
signal, emitted only after the redisvl embed + write-through completed.
The file's own frontmatter mapping is round-tripped (like
configure_skill) so author keys outside the write model — check,
related, created, settings_schema — survive. Classification runs ONLY
when facets are missing; complete frontmatter never touches the LLM.
One attempt end to end, fail loud (no retries).
"""

from __future__ import annotations

from pathlib import Path

from app.corpus.reader import parse_artifact_text, split_frontmatter
from app.corpus.schema import missing_rule_sections
from app.corpus.writer import reindex_artifact, render_raw_markdown, write_artifact
from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.mcp.add_skill.classify import classify_missing
from app.mcp.add_skill.schema import AddSkillInput

__all__ = ["NAME", "DESCRIPTION", "handle"]

NAME = "add_skill"
DESCRIPTION = (
    "Add a corpus rule or skill from a raw markdown file (frontmatter + body). "
    "Missing facets are filled by one classification call, then the artifact "
    "is written to the global corpus and embedded/indexed for hybrid "
    "retrieval — searchable the moment the 'indexed' progress stage fires."
)

INPUT_SOURCE = "add_skill:markdown"

# Facets the classifier can fill; anything else must come from the file.
_CLASSIFIABLE = ("id", "artifact_type", "title", "category", "domain", "when_to_use")


async def handle(
    input: AddSkillInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    frontmatter, body = split_frontmatter(INPUT_SOURCE, input.markdown)
    if not body.strip():
        raise Errors.artifact_invalid(INPUT_SOURCE, "markdown body is empty")
    await _emit(on_progress, "parsed", {"id": frontmatter.get("id"), "facets": sorted(frontmatter)})
    missing = _missing_facets(frontmatter)
    if missing:
        client = deps.chat.get()
        frontmatter = {
            **frontmatter,
            **classify_missing(frontmatter, body, missing, deps.settings, client),
        }
    if input.forced is not None:
        frontmatter["forced"] = input.forced
    await _emit(on_progress, "classified", {"filled": missing, "used_llm": bool(missing)})
    artifact_type = frontmatter.get("artifact_type")
    if artifact_type not in ("rule", "skill"):
        raise Errors.artifact_invalid(
            INPUT_SOURCE, f"artifact_type must be 'rule' or 'skill', got {artifact_type!r}"
        )
    if artifact_type == "rule" and (gaps := missing_rule_sections(body)):
        raise Errors.artifact_invalid(
            str(frontmatter.get("id", INPUT_SOURCE)),
            f"rule body missing required sections: {', '.join(gaps)}",
        )
    path = (
        Path(deps.corpus.global_root)
        / f"{artifact_type}s"
        / str(frontmatter["category"])
        / f"{frontmatter['id']}.md"
    )
    rendered = render_raw_markdown(frontmatter, body)
    artifact = parse_artifact_text(
        rendered, artifact_type=artifact_type, scope="global", source_path=str(path)
    )
    write_artifact(path, rendered)
    await reindex_artifact(deps, artifact, path)
    await _emit(on_progress, "indexed", {"id": artifact.id})
    deps.audit.record(
        "skill_added",
        {
            "id": artifact.id,
            "path": str(path),
            "classified": missing,
            "forced": artifact.forced,
            "indexed": True,
        },
        meta,
    )
    return {"id": artifact.id, "path": str(path), "classified": missing, "indexed": True}


def _missing_facets(frontmatter: dict) -> list[str]:
    missing = [facet for facet in _CLASSIFIABLE if not frontmatter.get(facet)]
    if frontmatter.get("artifact_type") not in (None, "rule", "skill"):
        raise Errors.artifact_invalid(
            INPUT_SOURCE,
            f"artifact_type must be 'rule' or 'skill', got {frontmatter['artifact_type']!r}",
        )
    hints = frontmatter.get("applies_when") or {}
    if not isinstance(hints, dict) or not hints.get("intents"):
        missing.append("intents")
    if frontmatter.get("artifact_type") == "rule" and not frontmatter.get("severity"):
        missing.append("severity")
    return missing


async def _emit(on_progress: ProgressFn | None, stage: str, payload: dict) -> None:
    if on_progress is not None:
        await on_progress(stage, payload)
