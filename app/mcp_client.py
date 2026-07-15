"""Minimal MCP client for CLI verbs: JSON-RPC over Streamable HTTP.

Extracted from app/cli.py so the CLI stays under the file-size budget and
the wire protocol lives in one place. One attempt end to end — transport
failures surface as BAI-601 with the start prompt (no offline mode).
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from app.errors import Errors
from app.installer.install_env import MCP_PORT, SERVER_HOST, betterai_root

PROTOCOL_VERSION = "2025-06-18"
BASE_URL = f"http://{SERVER_HOST}:{MCP_PORT}"


def read_token(user_home: str) -> str:
    token_path = Path(betterai_root(user_home)) / "token"
    if not token_path.exists():
        raise Errors.token_missing(str(token_path))
    return token_path.read_text().strip()


def server_get(user_home: str, path: str) -> dict:
    try:
        response = httpx.get(
            f"{BASE_URL}{path}",
            headers={"Authorization": f"Bearer {read_token(user_home)}"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise Errors.stack_unavailable("betterai server", str(exc)) from exc
    if response.status_code != 200:
        raise Errors.stack_unavailable(
            "betterai server", f"GET {path} -> HTTP {response.status_code}"
        )
    return response.json()


def server_post(user_home: str, path: str, payload: dict, *, timeout: float = 120.0) -> dict:
    try:
        response = httpx.post(
            f"{BASE_URL}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {read_token(user_home)}"},
            timeout=timeout,  # reindex/ingest embed the corpus; slower than a GET
        )
    except httpx.HTTPError as exc:
        raise Errors.stack_unavailable("betterai server", str(exc)) from exc
    if response.status_code != 200:
        raise Errors.stack_unavailable(
            "betterai server", f"POST {path} -> HTTP {response.status_code}: {response.text}"
        )
    return response.json()


def mcp_call(user_home: str, tool: str, arguments: dict) -> dict:
    """initialize, notifications/initialized, then tools/call — one attempt."""
    headers = {
        "Authorization": f"Bearer {read_token(user_home)}",
        "Accept": "application/json, text/event-stream",
    }
    url = f"{BASE_URL}/mcp"
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "betterai-cli", "version": "0.2.0"},
        },
    }
    call = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    try:
        with httpx.Client(headers=headers, timeout=60.0) as client:
            opened = client.post(url, json=init)
            session_id = opened.headers.get("mcp-session-id")
            if session_id:
                client.headers["mcp-session-id"] = session_id
            client.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            response = client.post(url, json=call)
    except httpx.HTTPError as exc:
        raise Errors.stack_unavailable("betterai server", str(exc)) from exc
    return _rpc_result(response)


def _rpc_result(response: httpx.Response) -> dict:
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        events = [
            line[5:].strip() for line in response.text.splitlines() if line.startswith("data:")
        ]
        message = json.loads(events[-1]) if events else {}
    else:
        message = response.json()
    if "error" in message:
        raise Errors.query_error(json.dumps(message["error"]))
    return message.get("result", {})
