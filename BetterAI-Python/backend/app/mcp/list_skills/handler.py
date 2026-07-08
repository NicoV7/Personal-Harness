"""list_skills — corpus inventory rows, no bodies.

Summary rows only (bodies come from get_skill) so agents can browse the
corpus without blowing their context budget.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps, ProgressFn
from app.mcp.list_skills.schema import ListSkillsInput

NAME = "list_skills"
DESCRIPTION = (
    "List every corpus artifact (rules and skills) as inventory rows: id, "
    "kind, title, category, severity, forced, scope. Use get_skill to read a "
    "full body."
)


async def handle(
    input: ListSkillsInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    artifacts = deps.corpus.read()
    if input.artifact_type is not None:
        artifacts = [artifact for artifact in artifacts if artifact.artifact_type == input.artifact_type]
    rows = [
        {
            "id": artifact.id,
            "artifact_type": artifact.artifact_type,
            "title": artifact.title,
            "category": artifact.category,
            "severity": artifact.severity,
            "forced": artifact.forced,
            "scope": artifact.scope,
        }
        for artifact in artifacts
    ]
    deps.audit.record("list", {"artifact_type": input.artifact_type, "count": len(rows)}, meta)
    return {"artifacts": rows}
