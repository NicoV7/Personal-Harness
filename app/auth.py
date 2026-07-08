"""Bearer auth + Host allowlist for the Starlette app.

ALL token/host verification lives in this one module so the security
roadmap (TLS termination, argon2 for stored credentials) upgrades a
single file, never handlers. The token is read ONCE at startup —
rotation requires a restart (half-written token files mid-rotation would
intermittently 401 valid clients; the installer writes the token exactly
once before startup). /health bypasses auth but every bypass is audited.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from pathlib import Path

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.audit import AuditLog
from app.errors import BetterAIError, Errors
from app.settings import Settings

_LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
_BEARER_RE = re.compile(r"^Bearer (.+)$")
BYPASS_PATHS = ("/health",)


class BearerAuth:
    """Verification core: loads the token at construction (fail loud),
    derives the Host allowlist, and exposes `verify` for the middleware."""

    def __init__(self, settings: Settings, audit: AuditLog) -> None:
        self._token = _load_token(settings.token_path)
        self._allowed_hosts = _allowed_hosts(settings)
        self._audit = audit

    def is_bypass(self, path: str) -> bool:
        return path in BYPASS_PATHS

    def audit_bypass(self, path: str, ip: str, ua: str) -> None:
        self._audit.record("auth_bypass", {"path": path, "ip": ip, "ua": ua})

    def verify(self, host: str | None, authorization: str | None) -> None:
        """Raise a typed error unless Host is allowlisted and the bearer
        token matches in constant time."""
        if host not in self._allowed_hosts:
            raise Errors.host_not_allowed(host or "<missing>")
        match = _BEARER_RE.match(authorization or "")
        if not match or not _constant_time_equal(match.group(1), self._token):
            raise Errors.unauthorized()


class BearerAuthMiddleware:
    """Pure ASGI middleware (not BaseHTTPMiddleware: that buffers and
    breaks the MCP SSE progress stream)."""

    def __init__(self, app: ASGIApp, auth: BearerAuth) -> None:
        self._app = app
        self._auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        headers = _header_map(scope)
        path = scope["path"]
        if self._auth.is_bypass(path):
            self._auth.audit_bypass(
                path,
                headers.get("x-forwarded-for") or headers.get("x-real-ip") or _client_ip(scope),
                headers.get("user-agent", "unknown"),
            )
            await self._app(scope, receive, send)
            return
        try:
            self._auth.verify(headers.get("host"), headers.get("authorization"))
        except BetterAIError as exc:
            response = JSONResponse(exc.envelope(), status_code=exc.http_status)
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)


def _load_token(path: str) -> str:
    """Trimmed because the installer writes a trailing newline; a file
    containing "token\\n" must match the header value "token"."""
    token_file = Path(path)
    if not token_file.exists():
        raise Errors.token_missing(path)
    raw = token_file.read_text(encoding="utf-8").strip()
    if not raw:
        raise Errors.token_missing(path)
    return raw


def _allowed_hosts(settings: Settings) -> frozenset[str]:
    if settings.allowed_hosts:
        return frozenset(settings.allowed_hosts)
    hosts = {f"{settings.bind_host}:{settings.mcp_port}"}
    if settings.bind_host in _LOOPBACK_HOSTS:
        hosts.add(f"localhost:{settings.mcp_port}")
        hosts.add(f"127.0.0.1:{settings.mcp_port}")
    return frozenset(hosts)


def _constant_time_equal(a: str, b: str) -> bool:
    """Hash both sides first so neither content nor LENGTH leaks timing."""
    digest_a = hashlib.sha256(a.encode("utf-8")).digest()
    digest_b = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(digest_a, digest_b)


def _header_map(scope: Scope) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }


def _client_ip(scope: Scope) -> str:
    client = scope.get("client")
    return client[0] if client else "unknown"
