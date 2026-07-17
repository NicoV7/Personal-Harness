"""Doctor checks as structured data, shared by the CLI and the local UI.

The CLI (`betterai doctor`) prints these rows; the host-side UI server
(`betterai ui`, PR2) serves them as JSON for the install/doctor panel.
Every check carries a `fix_hint` naming the exact recovery command so a
failure is actionable without reading source. Checks run host-side on
purpose: docker binaries, file modes, and client configs are invisible
from inside the container.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

from app.errors import BetterAIError
from app.installer.adapters import client_status
from app.installer.install_env import betterai_root
from app.mcp_client import server_get
from app.settings import REQUIRED_KEYS


@dataclass(frozen=True)
class DoctorCheck:
    id: str
    label: str
    ok: bool
    detail: str = ""
    fix_hint: str = ""
    # Advisory rows (per-client wiring) inform but never fail the doctor:
    # a machine without codex installed is healthy, not broken.
    advisory: bool = False

    def as_dict(self) -> dict:
        return asdict(self)


def run_doctor(user_home: str) -> list[DoctorCheck]:
    root = Path(betterai_root(user_home))
    checks = [
        _check(
            "docker",
            "docker on PATH",
            shutil.which("docker") is not None,
            fix_hint="install Docker Desktop: https://docs.docker.com/get-docker/",
        ),
        _check(
            "compose-file",
            "compose file",
            (root / "docker-compose.yml").exists(),
            fix_hint="run `betterai install` to write ~/.betterai/docker-compose.yml",
        ),
        _check(
            "token-mode",
            "token mode 0600",
            _is_private(root / "token"),
            fix_hint=f"chmod 600 {root / 'token'} (or `betterai install` if missing)",
        ),
        _check(
            "key-mode",
            "openrouter key mode 0600",
            _is_private(root / "openrouter-key"),
            fix_hint=f"chmod 600 {root / 'openrouter-key'}",
        ),
        _check(
            "key-present",
            "openrouter key non-empty",
            _has_content(root / "openrouter-key"),
            fix_hint=(
                f"write your OpenRouter API key to {root / 'openrouter-key'} "
                "(mode 0600), then `betterai index`"
            ),
        ),
        _check(
            "bridge",
            "bridge executable",
            os.access(root / "bin" / "betterai-mcp-stdio", os.X_OK),
            fix_hint="run `betterai harness on` to rewrite the stdio bridge",
        ),
        _env_check(root / ".env"),
        _health_check(user_home),
    ]
    for client in ("claude", "codex", "generic"):
        status = client_status(client, user_home)
        checks.append(
            DoctorCheck(
                id=f"client-{client}",
                label=f"client {client}",
                ok=status.installed,
                detail=f"{status.detail} {status.path}".strip(),
                fix_hint="" if status.installed else "run `betterai harness on` to wire this client",
                advisory=True,
            )
        )
    return checks


def failure_count(checks: list[DoctorCheck]) -> int:
    return sum(1 for check in checks if not check.ok and not check.advisory)


def _check(check_id: str, label: str, ok: bool, *, fix_hint: str) -> DoctorCheck:
    return DoctorCheck(id=check_id, label=label, ok=ok, fix_hint="" if ok else fix_hint)


def _is_private(path: Path) -> bool:
    return path.exists() and (path.stat().st_mode & 0o777) == 0o600


def _has_content(path: Path) -> bool:
    return path.exists() and bool(path.read_text(encoding="utf-8").strip())


def _env_check(env_path: Path) -> DoctorCheck:
    if not env_path.exists():
        return DoctorCheck(
            id="env",
            label=".env",
            ok=False,
            detail="missing",
            fix_hint="run `betterai install` to mint ~/.betterai/.env",
        )
    present = {line.split("=", 1)[0] for line in env_path.read_text().splitlines() if "=" in line}
    stale = [key for key in REQUIRED_KEYS if key not in present]
    if stale:
        return DoctorCheck(
            id="env",
            label=".env stale",
            ok=False,
            detail=f"missing: {', '.join(stale)}",
            fix_hint="re-run `betterai install` to regenerate .env (backs up the old one)",
        )
    return DoctorCheck(id="env", label=".env fresh", ok=True)


def _health_check(user_home: str) -> DoctorCheck:
    try:
        payload = server_get(user_home, "/health")
    except BetterAIError as exc:
        return DoctorCheck(
            id="server-health",
            label="server health",
            ok=False,
            detail=str(exc),
            fix_hint="run `betterai start` to bring the local stack up",
        )
    return DoctorCheck(
        id="server-health",
        label="server health",
        ok=True,
        detail=f"corpus_artifacts={payload.get('corpus_artifacts')} index={payload.get('index')}",
    )
