"""Host-side dashboard server for `betterai ui`.

Loopback-only Starlette app serving the bundled static frontend plus
/api/local/* (host data), and proxying every other /api/* call to the
container server with the bearer token injected from ~/.betterai/token —
the token never reaches browser JS or the URL bar.

Security posture (accepted): the UI port itself is unauthenticated on
127.0.0.1. That grants no new privilege — any same-user process can
already read the 0600 token file directly.
"""

from __future__ import annotations

import socket
import webbrowser
from pathlib import Path

from app.errors import BetterAIError, Errors
from app.installer.install_env import MCP_PORT, SERVER_HOST, betterai_root
from app.ui.local_api import local_routes

PREFERRED_UI_PORT = 7788
STATIC_DIR = Path(__file__).parent / "static"
# /api/server/<x> proxies to the container's non-/api operator routes.
SERVER_PREFIX = "/api/server"
PROXY_TIMEOUT_S = 60.0


def build_ui_app(user_home: str, upstream: str | None = None):
    import httpx
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, Response
    from starlette.routing import Mount, Route
    from starlette.staticfiles import StaticFiles

    base_url = upstream or f"http://{SERVER_HOST}:{MCP_PORT}"
    token_path = Path(betterai_root(user_home)) / "token"

    async def proxy(request) -> Response:
        path = "/api/" + request.path_params["path"]
        if path.startswith(SERVER_PREFIX + "/"):
            path = path[len(SERVER_PREFIX) :]  # /api/server/health -> /health
        try:
            token = token_path.read_text(encoding="utf-8").strip()
        except OSError:
            missing = Errors.token_missing(str(token_path))
            return JSONResponse(missing.envelope(), status_code=503)
        headers = {"Authorization": f"Bearer {token}"}
        if content_type := request.headers.get("content-type"):
            headers["Content-Type"] = content_type
        try:
            async with httpx.AsyncClient(base_url=base_url, timeout=PROXY_TIMEOUT_S) as client:
                response = await client.request(
                    request.method,
                    path,
                    params=request.query_params,
                    content=await request.body(),
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            unavailable = Errors.stack_unavailable("betterai server", str(exc))
            return JSONResponse(unavailable.envelope(), status_code=503)
        return Response(
            response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type"),
        )

    routes = [
        *local_routes(user_home),
        Route("/api/{path:path}", proxy, methods=["GET", "POST", "PUT", "DELETE"]),
        Mount("/", app=StaticFiles(directory=STATIC_DIR, html=True)),
    ]
    return Starlette(routes=routes)


def bind_ui_socket(port: int | None) -> socket.socket:
    """Bind once and hand the socket to uvicorn — no TOCTOU rebind.

    Explicit --port must fail loud when busy; the default tries 7788 and
    falls back to an OS-assigned free port.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if port is not None:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            sock.close()
            raise Errors.config_invalid("--port", f"cannot bind 127.0.0.1:{port}: {exc}") from exc
        return sock
    try:
        sock.bind(("127.0.0.1", PREFERRED_UI_PORT))
    except OSError:
        sock.bind(("127.0.0.1", 0))
    return sock


def run_ui(user_home: str, *, port: int | None = None, open_browser: bool = True) -> None:
    import uvicorn

    from app.mcp_client import server_get

    sock = bind_ui_socket(port)
    url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    try:
        server_get(user_home, "/health")
    except BetterAIError as exc:
        # The doctor panel is most useful when the stack is down, so a
        # dead server is a warning here, never an exit.
        print(f"warn: betterai server unreachable ({exc}); skills pages will fail until it is up")
    print(f"BetterAI UI: {url}")
    if open_browser:
        webbrowser.open(url)
    config = uvicorn.Config(build_ui_app(user_home), log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])
