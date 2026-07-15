"""Install smoke: prove the install path wires a real harness.

Dry-run installs into a throwaway HOME and checks the tree, file modes,
hook entries, auto-allowed permissions, instruction sentinels, and that
no secret VALUE leaks into any client config. Full mode additionally
probes the LIVE install: /health plus a query_skills round-trip through
the real MCP endpoint.
"""

from __future__ import annotations

import json
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from app.errors import BetterAIError
from app.installer.adapters import AUTO_ALLOWED_TOOLS
from app.settings import REQUIRED_KEYS

SMOKE_JUDGE_MODEL = "smoke/judge-model"
_PRIVATE_MODE = 0o600
_TREE_SUBDIRS = ("audit", "hooks", "bin", "config", "rules", "skills")


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str = ""


def run_install_smoke(*, dry_run: bool, user_home: str) -> dict:
    checks = _dry_run_checks()
    if not dry_run:
        checks += _live_checks(user_home)
    return {
        "dry_run": dry_run,
        "passed": all(check.ok for check in checks),
        "checks": [asdict(check) for check in checks],
    }


def _dry_run_checks() -> list[Check]:
    from app.cli import perform_install  # local import: cli imports evals

    checks: list[Check] = []
    with tempfile.TemporaryDirectory(prefix="betterai-smoke-") as home:
        key_file = Path(home) / "smoke-openrouter-key"
        key_value = "smoke-key-value-not-a-real-secret"
        key_file.write_text(key_value + "\n")
        try:
            perform_install(
                home,
                clients=["claude", "codex"],
                granularity="none",
                memory_provider="none",
                judge_model=SMOKE_JUDGE_MODEL,
                openrouter_key_file=str(key_file),
                run_client_exec=False,
            )
        except BetterAIError as error:
            return [Check("install", False, f"[{error.code}] {error}")]
        checks.append(Check("install", True))
        root = Path(home) / ".betterai"
        checks += _tree_checks(root)
        checks += _claude_checks(Path(home))
        checks += _codex_checks(Path(home))
        checks += _secret_checks(Path(home), root, key_value)
    return checks


def _tree_checks(root: Path) -> list[Check]:
    checks = [
        Check(f"tree {subdir}/", (root / subdir).is_dir()) for subdir in _TREE_SUBDIRS
    ]
    for name in ("token", "openrouter-key", ".env"):
        path = root / name
        private = path.exists() and (path.stat().st_mode & 0o777) == _PRIVATE_MODE
        checks.append(Check(f"{name} mode 0600", private))
    env_text = (root / ".env").read_text() if (root / ".env").exists() else ""
    present = {line.split("=", 1)[0] for line in env_text.splitlines() if "=" in line}
    missing = [key for key in REQUIRED_KEYS if key not in present]
    checks.append(Check(".env complete", not missing, ", ".join(missing)))
    checks.append(
        Check("bridge executable", (root / "bin" / "betterai-mcp-stdio").exists())
    )
    return checks


def _claude_checks(home: Path) -> list[Check]:
    path = home / ".claude" / "settings.json"
    if not path.exists():
        return [Check("claude settings.json", False, "not written")]
    settings = json.loads(path.read_text())
    hooks_ok = ".betterai/hooks" in path.read_text()
    allow = settings.get("permissions", {}).get("allow", [])
    return [
        Check("claude hooks wired", hooks_ok),
        Check(
            "claude auto-allowed skill reads",
            all(tool in allow for tool in AUTO_ALLOWED_TOOLS),
            f"allow={allow}",
        ),
        Check(
            "claude mutating tools NOT auto-allowed",
            not any("edit_skill" in item or "start_container" in item for item in allow),
        ),
    ]


def _codex_checks(home: Path) -> list[Check]:
    config = home / ".codex" / "config.toml"
    ok = config.exists() and "betterai" in config.read_text()
    return [Check("codex managed block", ok)]


def _secret_checks(home: Path, root: Path, key_value: str) -> list[Check]:
    token_value = (root / "token").read_text().strip()
    client_artifacts = [
        home / ".claude" / "settings.json",
        home / ".codex" / "config.toml",
        root / "config" / "claude-code.mcp.json",
    ]
    leaks = [
        str(path)
        for path in client_artifacts
        if path.exists() and (token_value in path.read_text() or key_value in path.read_text())
    ]
    return [Check("no secret values in client configs", not leaks, ", ".join(leaks))]


def _live_checks(user_home: str) -> list[Check]:
    from app.mcp_client import mcp_call, server_get  # local import: network layer

    checks: list[Check] = []
    try:
        health = server_get(user_home, "/health")
        checks.append(Check("live /health", health.get("status") == "ok", json.dumps(health)))
    except BetterAIError as error:
        return checks + [Check("live /health", False, f"[{error.code}] {error}")]
    try:
        result = mcp_call(
            user_home, "query_skills", {"intent": "install smoke retrieval probe"}
        )
        checks.append(Check("live query_skills", isinstance(result, dict)))
    except BetterAIError as error:
        checks.append(Check("live query_skills", False, f"[{error.code}] {error}"))
    return checks
