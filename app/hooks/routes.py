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

from app.deps import Deps
from app.errors import BetterAIError
from app.hooks.events import HookDecision, PostToolUse, PreToolUse, SessionEnd, Stop, UserPromptSubmit
from app.mcp import registry
from app.mcp.plan_manifest_gate import store as manifest_store
from app.mcp.plan_manifest_gate.gate import mutated_paths, written_content
from app.mcp.plan_manifest_gate.parser import parse_files_to_touch
from app.mcp.read_gate import store as read_store
from app.mcp.retrieval_receipt_gate import store as receipt_store
from app.openrouter import make_chat_client
from app.retrieval.expand import Expansion, expand_prompt, expansion_enabled
from app.settings import CommentPolicy, parse_comment_policy

# The forced skill that only applies while an edit budget is active
# (plan decisions 7/8: edit-incrementally is injected only when
# granularity is not "none").
EDIT_INCREMENTALLY_SKILL_ID = "edit-incrementally"

# The configurable skill whose `settings.level` overrides the
# BETTERAI_COMMENT_VERBOSITY env seed (configure_skill writes it).
COMMENT_SKILL_ID = "concise-comments"


def hook_routes(deps: Deps) -> list[Route]:
    chain = registry.build_chain()

    async def user_prompt_submit(request: Request) -> JSONResponse:
        body = await _read_body(request)
        session_id = _session_id(body)
        prompt = _str_field(body, "prompt", "user_prompt", "message", "text")
        cwd = _str_field(body, "cwd") or None
        chain.run(UserPromptSubmit(session_id=session_id, prompt=prompt, cwd=cwd), deps)
        required, skills, warning = await _retrieve_required(deps, prompt)
        if session_id:
            read_store.set_required(deps.store, session_id, required)
            if warning is None:
                receipt_store.mark_retrieved(deps.store, session_id)
        return JSONResponse(
            {
                "ok": True,
                "block": False,
                "session_id": session_id,
                "required_skill_ids": required,
                "missing_skill_ids": read_store.missing(deps.store, session_id),
                "skills": skills,
                "instruction": _instruction(required),
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": _prompt_context(
                        required, warning, _comment_policy_line(deps)
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
    satisfied = (
        "BetterAI already reminded the agent to read required skills for this turn."
        if missing
        else "BetterAI required skills are satisfied for this turn."
    )
    return {
        "ok": True,
        "block": False,
        "hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": satisfied},
        **base,
    }


async def _retrieve_required(
    deps: Deps, prompt: str
) -> tuple[list[str], list[dict], str | None]:
    """Server-side retrieval for the turn: (required ids, summaries, warning).

    A typed infra failure must be VISIBLE (warning carried into
    additionalContext) but must not 500 the hook; forced skills still
    apply because the corpus is local.
    """
    forced_ids, forced_warning = _forced_skill_ids(deps)
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
            "Mutating tools stay gated until query_skills succeeds.",
            forced_warning,
            expansion_warning,
        )
        return forced_ids, [], warning
    artifacts = [getattr(result, "artifact", result) for result in results]
    skills = [a for a in artifacts if getattr(a, "artifact_type", "skill") == "skill"]
    ids = [skill.id for skill in skills]
    ids += [forced for forced in forced_ids if forced not in ids]
    summaries = [_skill_summary(skill) for skill in skills]
    return ids, summaries, _join_warnings(forced_warning, expansion_warning)


def _expand(deps: Deps, prompt: str) -> tuple[Expansion, str | None]:
    """Prompt-improver step: an empty Expansion plus a visible warning on
    failure — expansion enhances retrieval, it never gates it."""
    if not prompt or not expansion_enabled(deps.settings):
        return Expansion(), None
    try:
        return expand_prompt(prompt, deps.settings, make_chat_client(deps.settings)), None
    except BetterAIError as error:
        return Expansion(), (
            f"BetterAI prompt expansion FAILED [{error.code}]: {error}. "
            "Retrieval used the raw prompt only."
        )


async def _surface_plan_skills(deps: Deps, event: PostToolUse) -> str | None:
    """Plan-mode skill surfacing: when the agent writes a plan file, run
    one extra retrieval over the plan's headings and '## Files to touch'
    paths and add the matched skills to this session's required reads."""
    if not event.session_id or event.tool_name not in registry.MUTATING_TOOL_NAMES:
        return None
    plan_paths = [
        path
        for path in mutated_paths(event.tool_input)
        if manifest_store.matches_plan_glob(path, deps.settings.plan_glob)
    ]
    if not plan_paths:
        return None
    content = written_content(event.tool_input)
    headings = [
        line.lstrip("#").strip() for line in content.splitlines() if line.startswith("#")
    ]
    manifest = parse_files_to_touch(content)
    file_paths = [entry.path for entry in manifest.entries] if manifest.ok else None
    try:
        results = await deps.pipeline.query(
            intent="; ".join(headings[:8]) or "implementation plan",
            aspects=headings[1:9] or None,
            file_paths=file_paths,
        )
    except BetterAIError as error:
        return (
            f"BetterAI plan skill surfacing FAILED [{error.code}]: {error}. "
            "The plan proceeds without extra skill requirements."
        )
    artifacts = [getattr(result, "artifact", result) for result in results]
    skills = [a for a in artifacts if getattr(a, "artifact_type", "skill") == "skill"]
    if not skills:
        return None
    ids = [skill.id for skill in skills]
    read_store.mark_required(deps.store, event.session_id, ids)
    return (
        "BetterAI plan-mode skills surfaced for this plan: call get_skill for "
        f"{', '.join(ids)} before implementing."
    )


def _forced_skill_ids(deps: Deps) -> tuple[list[str], str | None]:
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
    ids = [
        artifact.id
        for artifact in artifacts
        if getattr(artifact, "forced", False)
        and not (artifact.id == EDIT_INCREMENTALLY_SKILL_ID and granularity == "none")
    ]
    return ids, None


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


def _instruction(required: list[str]) -> str:
    if not required:
        return "No required skills matched this prompt."
    return (
        "Call get_skill for every required_skill_id before planning, "
        "answering, or using ordinary tools."
    )


def _prompt_context(
    required: list[str], warning: str | None, comment_line: str | None = None
) -> str:
    lines = [warning] if warning else []
    if not required:
        lines.append(
            "BetterAI retrieved context for this prompt. No harness skills "
            "matched, so continue normally."
        )
    else:
        lines += [
            "BetterAI retrieved required harness skills for this prompt.",
            "Before planning, answering, or using ordinary tools, call "
            "get_skill for every required_skill_id.",
            f"Required BetterAI skill reads: {', '.join(required)}.",
        ]
    if comment_line:
        lines.append(comment_line)
    return "\n".join(lines)


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

