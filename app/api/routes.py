"""REST routes for the local web UI — thin wrappers over MCP handlers.

These are NOT MCP tools (the agent tool surface grows only by explicit
user decision, see registry.TOOL_MODULES); they exist so the `betterai
ui` host process can drive skill CRUD over plain HTTP. Bearer auth is
inherited from BearerAuthMiddleware like every non-/health route.

Calls carry CallMeta(agent_session_id=None, subagent_class="ui") — the
None session id makes get_skill's read-receipt bookkeeping a no-op, so
UI reads can never mutate gate state, while subagent_class="ui" keeps
the audit events attributable (and excludable from usage stats).
"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic import ValidationError

from app.deps import CallMeta, Deps
from app.errors import BetterAIError, Errors
from app.mcp.add_skill import handler as add_skill
from app.mcp.add_skill.schema import AddSkillInput
from app.mcp.configure_skill import handler as configure_skill
from app.mcp.configure_skill.schema import ConfigureSkillInput
from app.mcp.edit_skill import handler as edit_skill
from app.mcp.edit_skill.schema import EditSkillInput
from app.mcp.get_skill import handler as get_skill
from app.mcp.get_skill.schema import GetSkillInput
from app.mcp.list_skills import handler as list_skills
from app.mcp.list_skills.schema import ListSkillsInput

__all__ = ["api_routes"]


def api_routes(deps: Deps) -> list:
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def skills_index(request: Request) -> JSONResponse:
        artifact_type = request.query_params.get("artifact_type")
        result = await list_skills.handle(
            ListSkillsInput(artifact_type=artifact_type), deps, _ui_meta()
        )
        return JSONResponse(result)

    async def skill_detail(request: Request) -> JSONResponse:
        result = await get_skill.handle(
            GetSkillInput(skill_id=request.path_params["skill_id"]), deps, _ui_meta()
        )
        return JSONResponse(result)

    async def skill_raw(request: Request) -> JSONResponse:
        skill_id = request.path_params["skill_id"]
        artifact = deps.corpus.find(skill_id)
        if artifact is None or not artifact.source_path:
            raise Errors.artifact_not_found(skill_id)
        from pathlib import Path

        return JSONResponse(
            {
                "id": artifact.id,
                "path": artifact.source_path,
                "markdown": Path(artifact.source_path).read_text(encoding="utf-8"),
            }
        )

    async def skill_upsert(request: Request) -> JSONResponse:
        payload = await _json_body(request)
        spec = EditSkillInput(**payload)
        skill_id = request.path_params.get("skill_id")
        if skill_id is not None and spec.artifact.id != skill_id:
            raise Errors.artifact_invalid(
                skill_id, f"path id does not match artifact.id {spec.artifact.id!r}"
            )
        result = await edit_skill.handle(spec, deps, _ui_meta())
        return JSONResponse(result)

    async def skill_settings(request: Request) -> JSONResponse:
        payload = await _json_body(request)
        result = await configure_skill.handle(
            ConfigureSkillInput(
                skill_id=request.path_params["skill_id"],
                settings=payload.get("settings") or {},
            ),
            deps,
            _ui_meta(),
        )
        return JSONResponse(result)

    async def skill_from_markdown(request: Request) -> JSONResponse:
        payload = await _json_body(request)
        result = await add_skill.handle(AddSkillInput(**payload), deps, _ui_meta())
        return JSONResponse(result)

    return [
        Route("/api/skills", _wrap(skills_index), methods=["GET"]),
        Route("/api/skills", _wrap(skill_upsert), methods=["POST"]),
        Route("/api/skills/markdown", _wrap(skill_from_markdown), methods=["POST"]),
        Route("/api/skills/{skill_id}", _wrap(skill_detail), methods=["GET"]),
        Route("/api/skills/{skill_id}", _wrap(skill_upsert), methods=["PUT"]),
        Route("/api/skills/{skill_id}/raw", _wrap(skill_raw), methods=["GET"]),
        Route("/api/skills/{skill_id}/settings", _wrap(skill_settings), methods=["POST"]),
    ]


def _ui_meta() -> CallMeta:
    return CallMeta(
        agent_session_id=None,
        parent_agent_session_id=None,
        subagent_class="ui",
        tool_call_id=str(uuid.uuid4()),
    )


async def _json_body(request: Any) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise Errors.config_invalid("body", "expected a JSON object")
    return body


def _wrap(endpoint: Any) -> Any:
    """Typed-envelope error handling, same contract as ops_routes: one
    attempt, BetterAIError -> its envelope + http_status; pydantic input
    rejections -> BAI-121 at 400."""
    from starlette.responses import JSONResponse

    async def wrapped(request: Any) -> JSONResponse:
        try:
            return await endpoint(request)
        except ValidationError as exc:
            invalid = Errors.config_invalid("body", str(exc))
            return JSONResponse(invalid.envelope(), status_code=400)
        except BetterAIError as exc:
            return JSONResponse(exc.envelope(), status_code=exc.http_status)

    return wrapped
