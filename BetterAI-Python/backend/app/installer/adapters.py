"""Client adapters: wire BetterAI into claude / codex / generic clients.

Port of the TS `src/cli/adapters.ts` (the installer trust boundary).
Everything the adapters write is reversible: JSON hook entries are
removed by exact-match filtering, and text configs use one replaceable
sentinel block ("# >>> / # <<< betterai managed") so `harness off`
reverts cleanly. No secret is ever written into a client config -- the
bridge and hook scripts read the token at runtime.

Codex has no hooks, so its lever is the AGENTS.md instructions block
naming the query_skills/get_skill contract and the gates (documented
limitation, plan Migration table).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from app.errors import Errors
from app.installer.bridge import bridge_path
from app.installer.install_env import betterai_root

CLIENT_NAMES = ("claude", "codex", "generic")
SENTINEL_START = "# >>> betterai managed"
SENTINEL_END = "# <<< betterai managed"
HOOK_EVENTS = (
    ("UserPromptSubmit", "user-prompt-submit", None),
    ("PreToolUse", "pre-tool-use", "*"),
    ("PostToolUse", "post-tool-use", "*"),
    ("Stop", "stop", None),
    ("SessionEnd", "session-end", None),
)
from app.installer.instructions import ALWAYS_CONSULT_INSTRUCTIONS


@dataclass(frozen=True)
class ClientStatus:
    client: str
    installed: bool
    path: str
    detail: str


def install_client(client: str, user_home: str, *, run_client_exec: bool = False) -> ClientStatus:
    if client == "claude":
        return _install_claude(user_home, run_client_exec)
    if client == "codex":
        return _install_codex(user_home)
    return _install_generic(user_home)


def uninstall_client(client: str, user_home: str) -> ClientStatus:
    if client == "claude":
        return _uninstall_claude(user_home)
    if client == "codex":
        return _uninstall_codex(user_home)
    return _uninstall_generic(user_home)


def client_status(client: str, user_home: str) -> ClientStatus:
    if client == "claude":
        return _status_claude(user_home)
    if client == "codex":
        return _status_codex(user_home)
    return _status_generic(user_home)


def replace_sentinel_block(text: str, block_body: str) -> str:
    block = f"{SENTINEL_START}\n{block_body.strip()}\n{SENTINEL_END}"
    pattern = re.compile(
        re.escape(SENTINEL_START) + r"[\s\S]*?" + re.escape(SENTINEL_END)
    )
    if pattern.search(text):
        return pattern.sub(lambda _: block, text).rstrip() + "\n"
    separator = "\n\n" if text.strip() else ""
    return f"{text.rstrip()}{separator}{block}\n"


def remove_sentinel_block(text: str) -> str:
    pattern = re.compile(
        r"\n?" + re.escape(SENTINEL_START) + r"[\s\S]*?" + re.escape(SENTINEL_END) + r"\n?"
    )
    cleaned = pattern.sub("\n", text).rstrip()
    return cleaned + ("\n" if text.strip() else "")


def _install_claude(user_home: str, run_client_exec: bool) -> ClientStatus:
    settings_path = Path(user_home) / ".claude" / "settings.json"
    settings = _read_json_object(settings_path)
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = settings["hooks"] = {}
    for event, script, matcher in HOOK_EVENTS:
        _set_hook(hooks, event, _hook_path(user_home, script), matcher)
    _write_json(settings_path, settings)
    fallback = Path(betterai_root(user_home)) / "config" / "claude-code.mcp.json"
    _write_mcp_json(fallback, bridge_path(user_home))
    if run_client_exec:
        _maybe_run_claude_mcp_add(user_home)
    return ClientStatus(
        "claude", True, str(settings_path), "settings hooks plus claude mcp add when available"
    )


def _uninstall_claude(user_home: str) -> ClientStatus:
    settings_path = Path(user_home) / ".claude" / "settings.json"
    if settings_path.exists():
        settings = _read_json_object(settings_path)
        hooks = settings.get("hooks")
        if isinstance(hooks, dict):
            for event, entries in hooks.items():
                if isinstance(entries, list):
                    hooks[event] = [e for e in entries if not _is_betterai_hook(e)]
        _write_json(settings_path, settings)
    return _status_claude(user_home)


def _status_claude(user_home: str) -> ClientStatus:
    path = Path(user_home) / ".claude" / "settings.json"
    installed = path.exists() and ".betterai/hooks" in path.read_text()
    return ClientStatus("claude", installed, str(path), "settings.json hooks")


def _install_codex(user_home: str) -> ClientStatus:
    config_path = Path(user_home) / ".codex" / "config.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    block = "\n".join(
        (
            "[mcp_servers.betterai]",
            f'command = "{_escape_toml(bridge_path(user_home))}"',
            "startup_timeout_sec = 20",
            "tool_timeout_sec = 60",
        )
    )
    _write_private(config_path, replace_sentinel_block(_read_if_exists(config_path), block))
    instructions_path = _active_codex_instructions_path(user_home)
    _write_private(
        instructions_path,
        replace_sentinel_block(_read_if_exists(instructions_path), ALWAYS_CONSULT_INSTRUCTIONS),
    )
    return ClientStatus(
        "codex", True, str(config_path), f"managed TOML block plus {instructions_path}"
    )


def _uninstall_codex(user_home: str) -> ClientStatus:
    codex_dir = Path(user_home) / ".codex"
    candidates = (
        codex_dir / "config.toml",
        codex_dir / "AGENTS.md",
        codex_dir / "AGENTS.override.md",
    )
    for path in candidates:
        if path.exists():
            _write_private(path, remove_sentinel_block(path.read_text()))
    return _status_codex(user_home)


def _status_codex(user_home: str) -> ClientStatus:
    config_path = Path(user_home) / ".codex" / "config.toml"
    instructions_path = _active_codex_instructions_path(user_home)
    installed = _contains_sentinel(config_path) and _contains_sentinel(instructions_path)
    return ClientStatus(
        "codex", installed, str(config_path), f"config.toml plus {instructions_path}"
    )


def _install_generic(user_home: str) -> ClientStatus:
    config_dir = Path(betterai_root(user_home)) / "config"
    mcp_path = config_dir / "mcp.json"
    _write_mcp_json(mcp_path, bridge_path(user_home))
    instructions_path = config_dir / "instructions.md"
    _write_private(
        instructions_path,
        replace_sentinel_block(_read_if_exists(instructions_path), ALWAYS_CONSULT_INSTRUCTIONS),
    )
    return ClientStatus("generic", True, str(mcp_path), "generic MCP JSON plus instructions")


def _uninstall_generic(user_home: str) -> ClientStatus:
    config_dir = Path(betterai_root(user_home)) / "config"
    mcp_path = config_dir / "mcp.json"
    if mcp_path.exists():
        _write_private(mcp_path, "{}\n")
    instructions_path = config_dir / "instructions.md"
    if instructions_path.exists():
        _write_private(instructions_path, remove_sentinel_block(instructions_path.read_text()))
    return _status_generic(user_home)


def _status_generic(user_home: str) -> ClientStatus:
    config_dir = Path(betterai_root(user_home)) / "config"
    mcp_path = config_dir / "mcp.json"
    installed = (
        mcp_path.exists()
        and "betterai" in mcp_path.read_text()
        and _contains_sentinel(config_dir / "instructions.md")
    )
    return ClientStatus(
        "generic", installed, str(mcp_path), "generic MCP JSON plus instructions"
    )


def _set_hook(hooks: dict, event: str, command: str, matcher: str | None) -> None:
    entries = hooks.get(event)
    kept = [e for e in entries if not _is_betterai_hook(e)] if isinstance(entries, list) else []
    entry: dict = {"hooks": [{"type": "command", "command": command}]}
    if matcher is not None:
        entry["matcher"] = matcher
    kept.append(entry)
    hooks[event] = kept


def _is_betterai_hook(entry: object) -> bool:
    return ".betterai/hooks" in json.dumps(entry)


def _maybe_run_claude_mcp_add(user_home: str) -> None:
    # Absence of the `claude` CLI is fine (the fallback MCP JSON covers
    # it), but a FAILED registration must be visible — the user would
    # otherwise believe the server is registered when only the fallback
    # config exists.
    if shutil.which("claude") is None:
        return
    result = subprocess.run(
        ["claude", "mcp", "add", "--scope", "user", "betterai", "--", bridge_path(user_home)],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        print(
            "warning: `claude mcp add` failed "
            f"(exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}\n"
            "the fallback MCP config was written; register manually or re-run install",
            file=sys.stderr,
        )


def _active_codex_instructions_path(user_home: str) -> Path:
    override = Path(user_home) / ".codex" / "AGENTS.override.md"
    if override.exists() and override.read_text().strip():
        return override
    return Path(user_home) / ".codex" / "AGENTS.md"


def _hook_path(user_home: str, name: str) -> str:
    return str(Path(betterai_root(user_home)) / "hooks" / name)


def _escape_toml(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _contains_sentinel(path: Path) -> bool:
    return path.exists() and SENTINEL_START in path.read_text()


def _read_if_exists(path: Path) -> str:
    return path.read_text() if path.exists() else ""


def _read_json_object(path: Path) -> dict:
    """Fail loud on malformed JSON: this path feeds read-modify-WRITE of a
    user's own client config, so swallowing a parse error here would
    rewrite the file with only BetterAI's entries — destroying their
    settings. Better to stop and make the user fix the file."""
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise Errors.config_invalid(
            str(path),
            f"malformed JSON ({exc}); fix or remove the file, then re-run — "
            "refusing to rewrite it and lose your existing settings",
        ) from exc
    if not isinstance(parsed, dict):
        raise Errors.config_invalid(str(path), "expected a JSON object at top level")
    return parsed


def _write_mcp_json(path: Path, command: str) -> None:
    _write_json(path, {"mcpServers": {"betterai": {"command": command, "args": []}}})


def _write_json(path: Path, value: dict) -> None:
    _write_private(path, json.dumps(value, indent=2) + "\n")


def _write_private(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(0o600)
