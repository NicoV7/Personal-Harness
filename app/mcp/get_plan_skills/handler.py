"""get_plan_skills — serve a plan's cached skills to ANY session.

Subagents run under their own session ids, so the cache is keyed by plan
path (app/hooks/plan_cache.py) and this tool is the fetch path plans
instruct orchestrators to hand their subagents. A cold cache (server
restart, LRU eviction) falls back to corpus reads of the caller-supplied
ids from the plan's '## Skill Audit' table — the plan document is the
durable record, the cache only the fast path.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.hooks.plan_cache import PlanCacheEntry, PlanSkillMatch, now_iso
from app.mcp.get_plan_skills.schema import GetPlanSkillsInput
from app.mcp.read_gate import store as read_store

NAME = "get_plan_skills"
DESCRIPTION = (
    "Return the full bodies of the skills cached for a plan (default: the "
    "most recently captured plan). Subagents executing a plan call this "
    "before mutating files. Pass skill_ids from the plan's '## Skill Audit' "
    "table as the fallback for a cold cache (server restart)."
)


async def handle(
    input: GetPlanSkillsInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    entry = _resolve_entry(deps, input.plan_path)
    if entry is not None and entry.matches:
        skills = [_cached_row(match) for match in entry.matches.values()]
        return _serve(deps, meta, entry.plan_path, skills, missing=[], cache_hit=True)
    if input.skill_ids:
        skills, missing = _corpus_fallback(deps, input.skill_ids)
        plan_path = entry.plan_path if entry is not None else input.plan_path
        return _serve(deps, meta, plan_path, skills, missing=missing, cache_hit=False)
    if entry is not None:
        # A captured plan that matched nothing is a legitimate state, not
        # a miss — an empty serve must not read as "write the plan first".
        return _serve(deps, meta, entry.plan_path, [], missing=[], cache_hit=True)
    raise Errors.plan_cache_miss(input.plan_path)


def _serve(
    deps: Deps,
    meta: CallMeta,
    plan_path: str | None,
    skills: list[dict],
    *,
    missing: list[str],
    cache_hit: bool,
) -> dict:
    # Advisory receipts: MCP and hook session ids differ (same caveat as
    # get_skill); gates never depend on these.
    for skill in skills:
        read_store.mark_read(deps.store, meta.agent_session_id, skill["id"])
    deps.audit.record(
        "plan_serve",
        {
            "plan_path": plan_path,
            "served": [skill["id"] for skill in skills],
            "provenance": {skill["id"]: skill["provenance"] for skill in skills},
            "cache_hit": cache_hit,
        },
        meta,
    )
    return {
        "plan_path": plan_path,
        "cache_hit": cache_hit,
        "skills": skills,
        "missing_skill_ids": missing,
    }


def _cached_row(match: PlanSkillMatch) -> dict:
    return {
        "id": match.artifact.id,
        "title": match.artifact.title,
        "score": match.score,
        "provenance": match.provenance,
        "served_at": match.served_at,
        "body": getattr(match.artifact, "body", "") or "",
    }


def _corpus_fallback(deps: Deps, skill_ids: list[str]) -> tuple[list[dict], list[str]]:
    """Serve what the corpus still has; a stale audit id lands in
    missing_skill_ids instead of failing the whole serve."""
    skills: list[dict] = []
    missing: list[str] = []
    for skill_id in skill_ids:
        artifact = deps.corpus.find(skill_id)
        if artifact is None:
            missing.append(skill_id)
            continue
        skills.append(
            {
                "id": artifact.id,
                "title": artifact.title,
                "score": 0.0,
                "provenance": "plan-audit-fallback",
                "served_at": now_iso(),
                "body": getattr(artifact, "body", "") or "",
            }
        )
    return skills, missing


def _resolve_entry(deps: Deps, plan_path: str | None) -> PlanCacheEntry | None:
    if plan_path:
        return deps.plan_skills.get(plan_path)
    return deps.plan_skills.latest()
