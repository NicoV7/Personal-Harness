"""query_skills — one hybrid retrieval over the corpus, receipt + forced skills.

This tool owns only input shaping, the retrieval receipt, forced-skill
injection, and read-gate requirements; ranking belongs to the pipeline.
Forced skills are unioned in AFTER scoring (locked decision 7: injected
regardless of score) and every returned skill id becomes a read-gate
requirement — get_skill read receipts are the deterministic proof the
agent actually loaded them.
"""

from __future__ import annotations

from typing import Any

from app.corpus.router import glob_to_regex
from app.corpus.schema import AppliesWhen, Artifact
from app.deps import CallMeta, Deps, ProgressFn
from app.mcp.query_skills.schema import MAX_TOP_K, QueryContext, QuerySkillsInput

NAME = "query_skills"
DESCRIPTION = (
    "ALWAYS call query_skills as your first action on any code task. Runs one "
    "hybrid retrieval query over the corpus (rules + skills), streams stage "
    "progress (candidates -> fused -> reranked), and returns ranked artifacts "
    "plus any forced skills for this context. The prompt hook already serves "
    "and receipts required skills at delivery; read returned skills with get_skill."
)


async def handle(
    input: QuerySkillsInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    top_k = min(input.top_k, MAX_TOP_K) if input.top_k else None
    _mark_retrieval_receipt(deps, meta)
    scored = await deps.pipeline.query(
        intent=input.context.intent or "",
        aspects=input.aspects,
        file_paths=input.context.file_paths,
        symbols=input.context.symbols,
        domain=input.domain,
        artifact_type=input.artifact_type,
        top_k=top_k,
        on_progress=on_progress,
    )
    rows = [_row(item) for item in scored]
    rows.extend(_forced_skill_rows(deps, input.context, {row["id"] for row in rows}))
    _require_skill_reads(deps, meta, rows)
    overridden = deps.corpus.overridden_global_ids()
    match = "matched" if rows else "none"
    deps.audit.record(
        "retrieve",
        {
            "intent": input.context.intent,
            "top_k": top_k,
            "returned": [row["id"] for row in rows],
            "forced": [row["id"] for row in rows if row["reason"] == "forced"],
            "overridden_global_ids": overridden,
            "match": match,
        },
        meta,
    )
    return {"artifacts": rows, "overridden_global_ids": overridden, "match": match}


def _row(item: Any) -> dict:
    # ScoredArtifact shape (retrieval agent's contract): .artifact,
    # .score, and optionally .reason for how the item earned its place.
    artifact: Artifact = item.artifact
    row = {
        "id": artifact.id,
        "artifact_type": artifact.artifact_type,
        "title": artifact.title,
        "score": float(item.score),
        "reason": getattr(item, "reason", "scored"),
    }
    if artifact.when_to_use:
        row["when_to_use"] = artifact.when_to_use
    return row


def _forced_skill_rows(
    deps: Deps, context: QueryContext, already_returned: set[str]
) -> list[dict]:
    rows: list[dict] = []
    for artifact in deps.corpus.read():
        # Forced RULES union in too: "rules must be followed" is the product
        # contract, and the hook-side required set already includes them.
        if not artifact.forced:
            continue
        if artifact.id in already_returned:
            continue
        if not _applies(artifact.applies_when, context):
            continue
        row = {
            "id": artifact.id,
            "artifact_type": artifact.artifact_type,
            "title": artifact.title,
            "score": 1.0,
            "reason": "forced",
        }
        if artifact.when_to_use:
            row["when_to_use"] = artifact.when_to_use
        rows.append(row)
    return rows


def _applies(applies_when: AppliesWhen | None, context: QueryContext) -> bool:
    """A forced skill without activation hints applies to every call —
    forcing with no applies_when means 'always in context'."""
    if applies_when is None:
        return True
    if _intent_matches(applies_when.intents, context.intent):
        return True
    return _paths_match(applies_when.paths, context.file_paths)


def _intent_matches(keywords: list[str] | None, intent: str | None) -> bool:
    if not keywords or not intent:
        return False
    intent_lc = intent.lower()
    return any(keyword.lower() in intent_lc for keyword in keywords)


def _paths_match(globs: list[str] | None, file_paths: list[str] | None) -> bool:
    if not globs or not file_paths:
        return False
    patterns = [glob_to_regex(glob) for glob in globs]
    return any(pattern.match(path) for pattern in patterns for path in file_paths)


def _mark_retrieval_receipt(deps: Deps, meta: CallMeta) -> None:
    # Advisory for hook gates: the MCP transport session id differs from the
    # hook session id — the prompt hook's delivery receipt is the one gates see.
    if meta.agent_session_id is None:
        return
    deps.store.set(meta.agent_session_id, "retrieval_receipt", "retrieved", True)


def _require_skill_reads(deps: Deps, meta: CallMeta, rows: list[dict]) -> None:
    if meta.agent_session_id is None:
        return
    skill_ids = [row["id"] for row in rows if row["artifact_type"] == "skill"]
    skill_ids = skill_ids[: deps.settings.required_reads_max]
    if not skill_ids:
        return
    existing = deps.store.get(meta.agent_session_id, "read_gate", "required") or []
    merged = list(dict.fromkeys([*existing, *skill_ids]))
    deps.store.set(meta.agent_session_id, "read_gate", "required", merged)
