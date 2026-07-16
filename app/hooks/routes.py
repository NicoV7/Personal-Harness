"""Claude Code hook HTTP endpoints (thin: parse -> chain -> respond).

JSON field names mirror src/hooks/routes.ts exactly — the installed hook
scripts and the TS test suite are the wire contract. Endpoints always
answer 200: a hook that 500s would silently disable gating client-side,
so infra failures surface as additionalContext text instead (fail LOUD
in the agent's face, never a hidden fallback).
"""

from __future__ import annotations

from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.deps import CallMeta, Deps
from app.errors import BetterAIError
from app.hooks import plan_cache
from app.hooks.events import HookDecision, PostToolUse, PreToolUse, SessionEnd, Stop, UserPromptSubmit
from app.mcp import registry
from app.mcp.plan_manifest_gate import store as manifest_store
from app.mcp.plan_manifest_gate.gate import mutated_paths, plan_text
from app.mcp.plan_manifest_gate.parser import parse_files_to_touch
from app.mcp.read_gate import store as read_store
from app.mcp.retrieval_receipt_gate import store as receipt_store
from app.retrieval.expand import Expansion, expand_prompt, expansion_enabled
from app.settings import CommentPolicy, parse_comment_policy

# The forced skill that only applies while an edit budget is active
# (plan decisions 7/8: edit-incrementally is injected only when
# granularity is not "none").
EDIT_INCREMENTALLY_SKILL_ID = "edit-incrementally"

# The configurable skill whose `settings.level` overrides the
# BETTERAI_COMMENT_VERBOSITY env seed (configure_skill writes it).
COMMENT_SKILL_ID = "concise-comments"

# Plan-text retrieval: one aspect per '## ' section (heading + body head),
# batched to the prompt improver's MAX_ASPECTS bound so no single
# HybridQuery averages the whole plan away.
PLAN_ASPECT_BATCH = 8
PLAN_SECTION_CHARS = 240


def hook_routes(deps: Deps) -> list[Route]:
    chain = registry.build_chain()

    async def user_prompt_submit(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        prompt = _str_field(body, "prompt", "user_prompt", "message", "text")
        cwd = _str_field(body, "cwd") or None
        chain.run(UserPromptSubmit(session_id=session_id, prompt=prompt, cwd=cwd), deps)
        sync_line = deps.sync.ensure_fresh(deps)
        # A captured plan makes retrieval per-plan: serve from the plan
        # cache (zero embedding calls) and fall back to fresh retrieval
        # when no plan is active or the cache entry is gone.
        cached = _plan_cache_serve(deps, session_id)
        artifacts, skills, warning = (
            cached if cached is not None else await _retrieve_required(deps, prompt)
        )
        required = [artifact.id for artifact in artifacts]
        served = artifacts if warning is None else []
        if session_id:
            # Delivery IS the read event; a failed serve still receipts —
            # MCP receipts land under another session id, so denying deadlocks.
            read_store.set_required(
                deps.store, session_id, required if warning is None else []
            )
            receipt_store.mark_retrieved(deps.store, session_id)
            receipt_store.mark_prompt_seen(deps.store, session_id)
            for artifact in served:
                read_store.mark_read(deps.store, session_id, artifact.id)
            serve_payload = {
                "required": required,
                "served": len(served),
                "warning": bool(warning),
            }
            if cached is not None:
                serve_payload["plan_path"] = plan_cache.active_plan(deps.store, session_id)
            deps.audit.record(
                "prompt_serve",
                serve_payload,
                CallMeta(
                    agent_session_id=session_id,
                    parent_agent_session_id=None,
                    subagent_class="main",
                    tool_call_id="hook.user_prompt_submit",
                ),
            )
        return JSONResponse(
            {
                "ok": True,
                "block": False,
                "session_id": session_id,
                "required_skill_ids": required,
                "missing_skill_ids": read_store.missing(deps.store, session_id),
                "skills": skills,
                "instruction": _instruction(served),
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": _prompt_context(
                        served, warning, _comment_policy_line(deps), sync_line
                    ),
                },
            }
        )

    async def pre_tool_use(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        tool_name = _tool_name(body)
        event = PreToolUse(
            session_id=session_id,
            tool_name=tool_name,
            tool_input=_dict_field(body, "tool_input", "toolInput"),
        )
        decision = chain.run(event, deps)
        missing = read_store.missing(deps.store, session_id)
        return JSONResponse(_pre_tool_payload(decision, session_id, tool_name, missing))

    async def post_tool_use(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        tool_name = _tool_name(body)
        event = PostToolUse(
            session_id=session_id,
            tool_name=tool_name,
            tool_input=_dict_field(body, "tool_input", "toolInput"),
            tool_response=_dict_field(body, "tool_response", "toolResponse"),
            plan_content=_str_field(body, "plan_content") or None,
        )
        decision = chain.run(event, deps)
        plan_context = await _surface_plan_skills(deps, event)
        return JSONResponse(
            {
                "ok": True,
                "session_id": session_id,
                "tool_name": tool_name,
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": _join_warnings(
                        decision.additional_context, plan_context
                    ),
                },
            }
        )

    async def stop(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        decision = chain.run(Stop(session_id=session_id), deps)
        missing = read_store.missing(deps.store, session_id)
        return JSONResponse(_stop_payload(decision, session_id, missing))

    async def session_end(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        chain.run(SessionEnd(session_id=session_id), deps)
        return JSONResponse(
            {"ok": True, "session_id": session_id, "cleared": bool(session_id)}
        )

    return [
        Route("/hooks/user-prompt-submit", user_prompt_submit, methods=["POST"]),
        Route("/hooks/pre-tool-use", pre_tool_use, methods=["POST"]),
        Route("/hooks/post-tool-use", post_tool_use, methods=["POST"]),
        Route("/hooks/stop", stop, methods=["POST"]),
        Route("/hooks/session-end", session_end, methods=["POST"]),
    ]


def _pre_tool_payload(
    decision: HookDecision, session_id: str | None, tool_name: str, missing: list[str]
) -> dict:
    base = {"session_id": session_id, "tool_name": tool_name, "missing_skill_ids": missing}
    if not decision.deny:
        hook_output = {"hookEventName": "PreToolUse", "permissionDecision": "allow"}
        if decision.additional_context:
            hook_output["additionalContext"] = decision.additional_context
        return {
            "ok": True,
            "block": False,
            "permissionDecision": "allow",
            "hookSpecificOutput": hook_output,
            **base,
        }
    return {
        "ok": False,
        "block": True,
        "permissionDecision": "deny",
        "permissionDecisionReason": decision.reason,
        "reason": decision.reason,
        "error_code": decision.error_code,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": decision.reason,
        },
        **base,
    }


def _stop_payload(
    decision: HookDecision, session_id: str | None, missing: list[str]
) -> dict:
    base = {"session_id": session_id, "missing_skill_ids": missing}
    if decision.deny:
        hook_output = {"hookEventName": "Stop", "additionalContext": decision.reason}
        return {
            "ok": False,
            "block": True,
            "decision": "block",
            "reason": decision.reason,
            "hookSpecificOutput": hook_output,
            **base,
        }
    # No context on the allow path: any Stop additionalContext makes the
    # client re-invoke the agent, looping every turn-end forever.
    return {
        "ok": True,
        "block": False,
        "hookSpecificOutput": {"hookEventName": "Stop"},
        **base,
    }


def _plan_cache_serve(
    deps: Deps, session_id: str | None
) -> tuple[list, list[dict], str | None] | None:
    """Plan-scoped serve: once a plan is captured for this session, prompt
    turns are served from the plan cache with ZERO embedding calls. None
    falls back to fresh retrieval — no plan active, entry evicted/lost on
    restart, or the plan matched nothing (silent, never an error). The
    caller runs the SAME receipt block as fresh retrieval: delivery is
    still the read event and the retrieval receipt (77b3658 post-mortem)."""
    if not session_id:
        return None
    plan_path = plan_cache.active_plan(deps.store, session_id)
    if not plan_path:
        return None
    entry = deps.plan_skills.get(plan_path)
    if entry is None or not entry.matches:
        return None
    forced, forced_warning = _forced_artifacts(deps)
    ranked = sorted(entry.matches.values(), key=lambda match: match.score, reverse=True)
    artifacts = [match.artifact for match in ranked]
    required = _cap_required(forced, artifacts, deps.settings.required_reads_max)
    summaries = [
        _skill_summary(a)
        for a in artifacts
        if getattr(a, "artifact_type", "skill") == "skill"
    ]
    return required, summaries, forced_warning


async def _retrieve_required(
    deps: Deps, prompt: str
) -> tuple[list, list[dict], str | None]:
    """Server-side retrieval: (capped required artifacts, summaries, warning).

    Forced artifacts lead, scored ones follow, truncated to
    required_reads_max — the cap bounds both the receipts and the served
    body bytes. A typed infra failure must be VISIBLE (warning carried
    into additionalContext) but must not 500 the hook; on failure the
    caller RELEASES gating for the turn (receipt without requirements) —
    MCP-side receipts cannot reach the hook session id, so an armed gate
    with no in-turn remedy is a deadlock, not a guardrail.
    """
    forced_artifacts, forced_warning = _forced_artifacts(deps)
    expansion, expansion_warning = _expand(deps, prompt)
    try:
        results = await deps.pipeline.query(
            intent=prompt,
            aspects=expansion.aspects or None,
            file_paths=expansion.file_paths or None,
            symbols=expansion.symbols or None,
        )
    except BetterAIError as error:
        warning = _join_warnings(
            f"BetterAI retrieval FAILED [{error.code}]: {error}. "
            "Required skills were NOT served; gating is released for this "
            "turn — fix the stack (betterai doctor).",
            forced_warning,
            expansion_warning,
        )
        return _cap_required(forced_artifacts, [], deps.settings.required_reads_max), [], warning
    scored = [getattr(result, "artifact", result) for result in results]
    required = _cap_required(forced_artifacts, scored, deps.settings.required_reads_max)
    summaries = [_skill_summary(a) for a in scored if getattr(a, "artifact_type", "skill") == "skill"]
    return required, summaries, _join_warnings(forced_warning, expansion_warning)


def _cap_required(forced: list, scored: list, limit: int) -> list:
    forced_ids = {artifact.id for artifact in forced}
    ordered = [*forced, *[a for a in scored if a.id not in forced_ids]]
    return ordered[:limit]


def _expand(deps: Deps, prompt: str) -> tuple[Expansion, str | None]:
    """Prompt-improver step: an empty Expansion plus a visible warning on
    failure — expansion enhances retrieval, it never gates it."""
    if not prompt or not expansion_enabled(deps.settings):
        return Expansion(), None
    try:
        return expand_prompt(prompt, deps.settings, deps.chat.get()), None
    except BetterAIError as error:
        return Expansion(), (
            f"BetterAI prompt expansion FAILED [{error.code}]: {error}. "
            "Retrieval used the raw prompt only."
        )


async def _surface_plan_skills(deps: Deps, event: PostToolUse) -> str | None:
    """Plan-mode skill surfacing: when the agent writes a plan file, run
    retrieval over the FULL plan text (one aspect per '## ' section,
    batched) and cache the matches by plan path so any session — subagents
    included — can fetch them via get_plan_skills. Only matches NEW to the
    plan are served; the '## Skill Audit' section is stripped and an
    unchanged content hash skips retrieval entirely, so the audit
    write-back and repeated saves never loop the hook."""
    if not event.session_id or event.tool_name not in registry.MUTATING_TOOL_NAMES:
        return None
    plan_paths = [
        path
        for path in mutated_paths(event.tool_input)
        if manifest_store.matches_plan_glob(path, deps.settings.plan_glob)
    ]
    if not plan_paths:
        return None
    plan_path = manifest_store.normalize_path(plan_paths[0])
    plan_cache.set_active_plan(deps.store, event.session_id, plan_path)
    content, authoritative = plan_text(event)
    if not authoritative:
        # Edit/MultiEdit fragment without the shim's plan_content: the
        # session mapping is recorded, but a fragment must never poison
        # the cache — the next full write (or upgraded shim) fills it.
        return None
    stripped = plan_cache.strip_skill_audit(content)
    content_hash = plan_cache.plan_content_hash(stripped)
    entry = deps.plan_skills.get(plan_path)
    if entry is not None and entry.content_hash == content_hash:
        return None
    aspect_headings = _aspect_headings(plan_cache.plan_sections(stripped))
    manifest = parse_files_to_touch(content)
    file_paths = [item.path for item in manifest.entries] if manifest.ok else None
    intent = (
        "; ".join(heading for heading in aspect_headings.values() if heading != "preamble")
        or "implementation plan"
    )
    try:
        best = await _query_plan_aspects(deps, intent, list(aspect_headings), file_paths)
    except BetterAIError as error:
        return (
            f"BetterAI plan skill surfacing FAILED [{error.code}]: {error}. "
            "The plan proceeds without extra skill requirements."
        )
    matches = [
        plan_cache.PlanSkillMatch(
            artifact=getattr(result, "artifact", result),
            score=float(result.score),
            provenance=_plan_provenance(result, aspect_headings),
            served_at=plan_cache.now_iso(),
        )
        for result in best
    ]
    new_matches = deps.plan_skills.upsert(plan_path, content_hash, matches)
    served = new_matches[: deps.settings.required_reads_max]
    if not served:
        return None
    ids = [match.artifact.id for match in served]
    read_store.mark_required(deps.store, event.session_id, ids)
    for match in served:
        read_store.mark_read(deps.store, event.session_id, match.artifact.id)
    deps.audit.record(
        "plan_serve",
        {
            "plan_path": plan_path,
            "served": ids,
            "provenance": {match.artifact.id: match.provenance for match in served},
            "cache_hit": False,
        },
        CallMeta(
            agent_session_id=event.session_id,
            parent_agent_session_id=None,
            subagent_class="main",
            tool_call_id="hook.post_tool_use",
        ),
    )
    sections = "\n".join(_served_section(match.artifact) for match in served)
    return (
        "BetterAI plan-mode skills for this plan are served below (receipts "
        f"recorded at delivery; cached for get_plan_skills).\n{sections}"
    )


def _aspect_headings(sections: list[tuple[str, str]]) -> dict[str, str]:
    """Aspect text -> section heading, one aspect per plan section. The
    body head rides along so a section's content matches, not just its
    title; the preamble (before the first '## ') gets its own aspect."""
    aspects: dict[str, str] = {}
    for heading, body in sections:
        head = body[:PLAN_SECTION_CHARS]
        text = (f"{heading}: {head}" if heading else head).strip()
        if text:
            aspects[text] = heading or "preamble"
    return aspects


async def _query_plan_aspects(
    deps: Deps, intent: str, aspects: list[str], file_paths: list[str] | None
) -> list:
    """One pipeline query per batch of PLAN_ASPECT_BATCH aspects, unioned
    by artifact id keeping the best score (long plans exceed the
    per-query aspect bound; averaging them into one query loses phases)."""
    best: dict[str, Any] = {}
    batches = [
        aspects[start : start + PLAN_ASPECT_BATCH]
        for start in range(0, len(aspects), PLAN_ASPECT_BATCH)
    ] or [[]]
    for index, batch in enumerate(batches):
        results = await deps.pipeline.query(
            intent=intent,
            aspects=batch or None,
            file_paths=file_paths if index == 0 else None,
        )
        for result in results:
            artifact = getattr(result, "artifact", result)
            current = best.get(artifact.id)
            if current is None or float(result.score) > float(current.score):
                best[artifact.id] = result
    return list(best.values())


def _plan_provenance(result: Any, aspect_headings: dict[str, str]) -> str:
    matched = getattr(result, "provenance", None)
    if matched and matched in aspect_headings:
        return f"plan section '{aspect_headings[matched]}'"
    return "plan text"


def _forced_artifacts(deps: Deps) -> tuple[list, str | None]:
    """Forced artifacts are injected regardless of score; the
    incremental-edit skill only applies while a budget is active.
    A corpus read failure must be VISIBLE: silently returning [] would
    switch forced gating off while the harness claims it is on."""
    try:
        artifacts = deps.corpus.read()
    except BetterAIError as error:
        return [], (
            f"BetterAI corpus read FAILED [{error.code}]: {error}. "
            "Forced skills could NOT be injected this turn; fix the corpus."
        )
    granularity = deps.settings.edit_granularity
    forced = [
        artifact
        for artifact in artifacts
        if getattr(artifact, "forced", False)
        and not (artifact.id == EDIT_INCREMENTALLY_SKILL_ID and granularity == "none")
    ]
    return forced, None


def _join_warnings(*warnings: str | None) -> str | None:
    present = [w for w in warnings if w]
    return "\n".join(present) if present else None


def _skill_summary(skill: Any) -> dict:
    return {
        "id": skill.id,
        "title": getattr(skill, "title", skill.id),
        "scope": getattr(skill, "scope", "global"),
        "category": getattr(skill, "category", ""),
        "when_to_use": getattr(skill, "when_to_use", None) or "",
    }


def _instruction(served: list) -> str:
    if not served:
        return "No required skills matched this prompt."
    return (
        "The required skills are served inline in additionalContext and "
        "already receipted — apply them; call get_skill only for deeper reads."
    )


def _prompt_context(
    served: list,
    warning: str | None,
    comment_line: str | None = None,
    sync_line: str | None = None,
) -> str:
    lines = [warning] if warning else []
    if not served:
        lines.append(
            "BetterAI retrieved context for this prompt. No harness skills "
            "matched, so continue normally."
            if warning is None
            else "Required skills could NOT be served this turn; gating was "
            "released for this turn — fix the stack (betterai doctor)."
        )
    else:
        lines.append(
            "BetterAI required skills for this prompt are served below "
            "(receipts recorded at delivery). Apply them while working."
        )
        lines += [_served_section(artifact) for artifact in served]
    if comment_line:
        lines.append(comment_line)
    if sync_line:
        lines.append(sync_line)
    return "\n".join(lines)


def _served_section(artifact) -> str:
    title = getattr(artifact, "title", artifact.id)
    body = (getattr(artifact, "body", "") or "").strip()
    return f"## BetterAI required skill: {artifact.id} — {title}\n{body}"


def _comment_policy_line(deps: Deps) -> str | None:
    """The per-prompt comment budget, or None in default mode. Deterministic
    injection: this line rides every prompt, independent of retrieval."""
    policy = _resolve_comment_policy(deps)
    if policy.mode == "none":
        return (
            "BetterAI comment policy: write NO inline or block code comments in "
            "this task; docstrings on public APIs are still required."
        )
    if policy.mode == "tokens":
        return (
            "BetterAI comment policy: keep total new comment text under "
            f"{policy.limit} tokens across this task's edits."
        )
    if policy.mode == "lines":
        return (
            f"BetterAI comment policy: write at most {policy.limit} comment "
            "lines per edited file."
        )
    return None


def _resolve_comment_policy(deps: Deps) -> CommentPolicy:
    """The concise-comments skill's configured `level` wins over the env
    seed. Corpus failure falls back to env — it is already surfaced loudly
    by the forced-skill path in the same request, and the artifact's own
    settings_schema pattern makes a malformed stored level unparseable
    only if the file was edited outside configure_skill."""
    try:
        artifact = deps.corpus.find(COMMENT_SKILL_ID)
    except BetterAIError:
        return deps.settings.comment_verbosity
    level = (artifact.settings or {}).get("level") if artifact else None
    if not level:
        return deps.settings.comment_verbosity
    try:
        return parse_comment_policy(level)
    except ValueError:
        return deps.settings.comment_verbosity


async def _read_body(request: Request) -> dict[str, Any]:
    # Malformed hook payloads must not 500 (TS parity), but only parse
    # errors are tolerated — anything else propagates loudly.
    try:
        parsed = await request.json()
    except ValueError:  # JSONDecodeError and UnicodeDecodeError subclass it
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _session_id(body: dict[str, Any]) -> str | None:
    value = _str_field(body, "session_id", "sessionId", "conversation_id")
    if value:
        return value
    transcript = body.get("transcript_path")
    if isinstance(transcript, str) and transcript:
        return f"transcript:{transcript}"
    return None


def _tool_name(body: dict[str, Any]) -> str:
    value = _str_field(body, "tool_name", "toolName", "name")
    if value:
        return value
    tool = body.get("tool")
    if isinstance(tool, dict) and isinstance(tool.get("name"), str):
        return tool["name"]
    return ""


def _str_field(body: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _dict_field(body: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        value = body.get(key)
        if isinstance(value, dict):
            return value
    return {}

