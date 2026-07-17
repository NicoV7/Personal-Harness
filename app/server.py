"""BetterAI server wiring: FastMCP Streamable-HTTP + hook routes, one port.

ONE transport, ever: `mcp.http_app(path="/mcp")` mounted in a Starlette
app (rule no-stdio-mcp-transport). Bearer verification stays entirely in
app/auth.py — this module only installs the middleware. Boot indexes the
corpus exactly once and keeps serving on failure: boot crashes are
reserved for config errors (BAI-1xx); infra outages surface per-query as
typed BAI-6xx errors whose message says how to recover.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from app.audit import AuditLog
from app.auth import BearerAuth, BearerAuthMiddleware
from app.corpus.reader import CorpusReader
from app.deps import CallMeta, Deps, ProgressFn
from app.errors import BetterAIError
from app.hooks.state import InMemorySessionStore
from app.mcp import registry
from app.settings import Settings

logger = logging.getLogger("betterai")

# Stage -> progress value reported over the MCP stream (total is 3.0).
# query emits "results"; add_skill walks parsed -> classified -> indexed,
# where "indexed" is the searchable-now signal.
_PROGRESS_STAGES = {"results": 1.0, "parsed": 1.0, "classified": 2.0, "indexed": 3.0}


def build_deps(settings: Settings) -> Deps:
    # Imported here so importing this module never constructs the redis/
    # openai clients (tests import app.server for wiring only).
    from app.hooks.plan_cache import PlanSkillCache
    from app.openrouter import ChatClientProvider
    from app.retrieval import Retrieval
    from app.sync.skills import SkillsSync

    return Deps(
        settings=settings,
        audit=AuditLog(settings.audit_path),
        corpus=CorpusReader(settings.corpus_root),
        pipeline=Retrieval(settings),
        store=InMemorySessionStore(),
        chat=ChatClientProvider(settings),
        sync=SkillsSync(),
        plan_skills=PlanSkillCache(),
    )


def build_mcp(deps: Deps) -> Any:
    from fastmcp import Context, FastMCP

    mcp = FastMCP("betterai")
    for schema_module, handler_module in registry.tool_modules():
        tool_fn = _tool_fn(schema_module.INPUT_MODEL, handler_module, deps, Context)
        mcp.tool(tool_fn, name=handler_module.NAME, description=handler_module.DESCRIPTION)
    return mcp


def build_app(settings: Settings) -> Any:
    from starlette.applications import Starlette
    from starlette.routing import Mount

    from app.api.routes import api_routes
    from app.hooks.routes import hook_routes

    deps = build_deps(settings)
    mcp = build_mcp(deps)
    http_app = mcp.http_app(path="/mcp")

    routes = [
        health_route(deps),
        *ops_routes(deps),
        *api_routes(deps),
        *hook_routes(deps),
        Mount("/", app=http_app),
    ]
    app = Starlette(routes=routes, lifespan=_lifespan(http_app, deps))
    return BearerAuthMiddleware(app, BearerAuth(settings, deps.audit))


def health_route(deps: Deps) -> Any:
    """Liveness + non-secret memory/store counters (stdlib only). /health
    bypasses bearer auth, and infra probes must never 500 liveness — they
    degrade to null instead."""
    import resource
    import sys

    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def health(request: Any) -> JSONResponse:
        try:
            index = await deps.pipeline.health()
        except BetterAIError:
            index = None
        try:
            corpus_artifacts = len(deps.corpus.read())
        except BetterAIError:
            corpus_artifacts = None
        ru_maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # ru_maxrss is bytes on macOS but kilobytes on Linux.
        rss_kb = ru_maxrss // 1024 if sys.platform == "darwin" else ru_maxrss
        return JSONResponse(
            {
                "status": "ok",
                "service": "betterai",
                "sessions": deps.store.session_count(),
                "rss_kb": rss_kb,
                "corpus_artifacts": corpus_artifacts,
                "index": index,
            }
        )

    return Route("/health", health, methods=["GET"])


def ops_routes(deps: Deps) -> list:
    """Operator endpoints (bearer-protected like everything but /health).

    These are NOT MCP tools on purpose: the agent tool surface (see
    registry.TOOL_MODULES) grows only by explicit user decision;
    reindex/ingest are `betterai` CLI operations."""
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def reindex(request: Any) -> JSONResponse:
        try:
            summary = await deps.pipeline.index_corpus(deps.corpus.read())
        except BetterAIError as exc:
            return JSONResponse(exc.envelope(), status_code=503)
        deps.audit.record("reindex", summary)
        return JSONResponse(summary)

    async def ingest(request: Any) -> JSONResponse:
        from app.ingest.pipeline import run_ingest

        payload = await request.json()
        url = payload.get("url") if isinstance(payload, dict) else None
        if not isinstance(url, str) or not url:
            return JSONResponse(
                {"error": "BAI-121", "message": "POST /ingest needs {'url': <post url>}"},
                status_code=400,
            )
        try:
            summary = await run_ingest(url, deps)
        except BetterAIError as exc:
            return JSONResponse(exc.envelope(), status_code=exc.http_status)
        return JSONResponse(summary)

    async def sync(request: Any) -> JSONResponse:
        try:
            summary = await deps.sync.run_now(deps)
        except BetterAIError as exc:
            return JSONResponse(exc.envelope(), status_code=exc.http_status)
        return JSONResponse(summary)

    return [
        Route("/ingest", ingest, methods=["POST"]),
        Route("/reindex", reindex, methods=["POST"]),
        Route("/sync", sync, methods=["POST"]),
    ]


def main() -> None:
    """Boot: env -> settings -> app -> uvicorn. The ONLY place besides
    settings.py allowed to touch os.environ."""
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env(os.environ)
    uvicorn.run(build_app(settings), host=settings.bind_host, port=settings.mcp_port)


def _tool_fn(input_model: Any, handler_module: Any, deps: Deps, context_cls: type) -> Any:
    """Adapt one tool module to a FastMCP function whose signature mirrors
    INPUT_MODEL's fields, so the client-visible schema stays flat instead
    of nesting everything under a single 'input' object."""

    async def tool_fn(**kwargs: Any) -> dict:
        ctx = kwargs.pop("ctx")
        payload = input_model(**kwargs)
        return await handler_module.handle(
            payload, deps, _call_meta(ctx), on_progress=_progress_fn(ctx)
        )

    tool_fn.__name__ = handler_module.NAME
    tool_fn.__doc__ = handler_module.DESCRIPTION
    tool_fn.__signature__ = _signature(input_model, context_cls)  # type: ignore[attr-defined]
    tool_fn.__annotations__ = _annotations(input_model, context_cls)
    return tool_fn


def _signature(input_model: Any, context_cls: type) -> inspect.Signature:
    parameters = [
        inspect.Parameter(
            name,
            inspect.Parameter.KEYWORD_ONLY,
            default=inspect.Parameter.empty if field.is_required() else field.default,
            annotation=field.annotation,
        )
        for name, field in input_model.model_fields.items()
    ]
    parameters.append(
        inspect.Parameter("ctx", inspect.Parameter.KEYWORD_ONLY, annotation=context_cls)
    )
    return inspect.Signature(parameters, return_annotation=dict)


def _annotations(input_model: Any, context_cls: type) -> dict:
    annotations: dict = {
        name: field.annotation for name, field in input_model.model_fields.items()
    }
    annotations["ctx"] = context_cls
    annotations["return"] = dict
    return annotations


def _call_meta(ctx: Any) -> CallMeta:
    """Session identity as far as the transport exposes it. Threading the
    caller's own agent/parent/subagent ids through MCP request metadata is
    integration work; until then the MCP session id is the session key the
    gates share with the hook routes."""
    return CallMeta(
        agent_session_id=getattr(ctx, "session_id", None),
        parent_agent_session_id=None,
        subagent_class="main",
        tool_call_id=str(getattr(ctx, "request_id", "")),
    )


def _progress_fn(ctx: Any) -> ProgressFn:
    async def on_progress(stage: str, payload: dict) -> None:
        await ctx.report_progress(
            progress=_PROGRESS_STAGES.get(stage, 0.0), total=3.0
        )
        await ctx.info(f"{stage}: {json.dumps(payload, default=str)}")

    return on_progress


def _lifespan(http_app: Any, deps: Deps) -> Any:
    @asynccontextmanager
    async def lifespan(app: Any) -> Any:
        await _index_corpus_once(deps)
        async with http_app.lifespan(app):
            yield

    return lifespan


async def _index_corpus_once(deps: Deps) -> None:
    """One attempt, loud log, keep serving. No retry loop: the recovery
    path is `betterai start` + `betterai index`, prompted per query by
    BAI-601 until the stack is back."""
    try:
        summary = await deps.pipeline.index_corpus(deps.corpus.read())
    except BetterAIError as exc:
        logger.error(
            "boot corpus index FAILED [%s]: %s -- queries will fail until "
            "`betterai index` succeeds",
            exc.code,
            exc,
        )
        return
    logger.info("boot corpus index complete: %s", summary)
