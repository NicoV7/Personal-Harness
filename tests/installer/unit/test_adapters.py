"""Client adapters: single replaceable sentinel block, five Claude hook
entries, clean uninstall, and no secret in any generated config."""

from __future__ import annotations

import json
from pathlib import Path

from app.installer.adapters import (
    install_client,
    remove_sentinel_block,
    replace_sentinel_block,
    uninstall_client,
)

TOKEN_VALUE = "fixture-secret-token-value"


def _seed_token(user_home: Path) -> None:
    root = user_home / ".betterai"
    root.mkdir(parents=True, exist_ok=True)
    (root / "token").write_text(TOKEN_VALUE + "\n")


def test_sentinel_block_add_replace_remove_round_trip() -> None:
    # arrange
    original = "existing = true\n"
    # act
    once = replace_sentinel_block(original, "a = 1")
    twice = replace_sentinel_block(once, "a = 2")
    removed = remove_sentinel_block(twice)
    # assert
    assert twice.count(">>> betterai managed") == 1
    assert "a = 2" in twice and "a = 1" not in twice
    assert "betterai managed" not in removed
    assert "existing = true" in removed


def test_claude_adapter_installs_all_five_hook_events(tmp_path: Path) -> None:
    # arrange
    _seed_token(tmp_path)
    # act
    status = install_client("claude", str(tmp_path))
    # assert
    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    assert status.installed
    hooks = settings["hooks"]
    assert sorted(hooks) == ["PostToolUse", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]
    for event, script in (
        ("UserPromptSubmit", "user-prompt-submit"),
        ("PreToolUse", "pre-tool-use"),
        ("PostToolUse", "post-tool-use"),
        ("Stop", "stop"),
        ("SessionEnd", "session-end"),
    ):
        assert f".betterai/hooks/{script}" in json.dumps(hooks[event])
    assert hooks["PreToolUse"][0]["matcher"] == "*"
    assert hooks["PostToolUse"][0]["matcher"] == "*"


def test_claude_install_is_idempotent_and_uninstall_removes_entries(tmp_path: Path) -> None:
    # arrange
    _seed_token(tmp_path)
    settings_path = tmp_path / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/usr/local/bin/user-owned"}]}]}}))
    # act
    install_client("claude", str(tmp_path))
    install_client("claude", str(tmp_path))
    # assert
    installed = settings_path.read_text()
    assert installed.count(".betterai/hooks/stop") == 1
    assert "/usr/local/bin/user-owned" in installed
    fallback = tmp_path / ".betterai" / "config" / "claude-code.mcp.json"
    assert "betterai-mcp-stdio" in fallback.read_text()
    uninstall_client("claude", str(tmp_path))
    cleaned = settings_path.read_text()
    assert ".betterai/hooks" not in cleaned
    assert "/usr/local/bin/user-owned" in cleaned


def test_codex_adapter_writes_sentinel_toml_and_agents_instructions(tmp_path: Path) -> None:
    # arrange
    _seed_token(tmp_path)
    # act
    install_client("codex", str(tmp_path))
    install_client("codex", str(tmp_path))
    # assert
    config = (tmp_path / ".codex" / "config.toml").read_text()
    assert config.count(">>> betterai managed") == 1
    assert "[mcp_servers.betterai]" in config
    assert "betterai-mcp-stdio" in config
    agents = (tmp_path / ".codex" / "AGENTS.md").read_text()
    assert agents.count(">>> betterai managed") == 1
    assert "For every user prompt" in agents
    assert "clean-code pass" in agents
    assert "query_skills" in agents and "get_skill" in agents
    off = uninstall_client("codex", str(tmp_path))
    assert not off.installed
    assert "BetterAI Harness" not in (tmp_path / ".codex" / "AGENTS.md").read_text()


def test_generic_adapter_round_trips_mcp_json_and_instructions(tmp_path: Path) -> None:
    # arrange
    _seed_token(tmp_path)
    # act
    status = install_client("generic", str(tmp_path))
    # assert
    config_dir = tmp_path / ".betterai" / "config"
    assert status.installed
    assert "betterai-mcp-stdio" in (config_dir / "mcp.json").read_text()
    instructions = (config_dir / "instructions.md").read_text()
    assert "For every user prompt" in instructions
    assert "clean-code pass" in instructions
    off = uninstall_client("generic", str(tmp_path))
    assert not off.installed
    assert "BetterAI Harness" not in (config_dir / "instructions.md").read_text()


def test_no_generated_client_config_leaks_the_token(tmp_path: Path) -> None:
    # arrange
    _seed_token(tmp_path)
    # act
    for client in ("claude", "codex", "generic"):
        install_client(client, str(tmp_path))
    # assert
    token_path = tmp_path / ".betterai" / "token"
    for path in tmp_path.rglob("*"):
        if path.is_file() and path != token_path:
            assert TOKEN_VALUE not in path.read_text(), f"token leaked into {path}"
