"""End-to-end install into a temp HOME: full file tree, private modes
for secrets (0600), executable modes for scripts (0755), backup on
reinstall, and no token leak anywhere."""

from __future__ import annotations

from pathlib import Path

from app.cli import perform_install
from app.settings import REQUIRED_KEYS


def _install(tmp_path: Path, **kwargs) -> Path:
    key_file = tmp_path / "openrouter-key-source"
    if not key_file.exists():
        key_file.write_text("fixture-openrouter-key\n")
    defaults = {
        "clients": ["claude", "codex", "generic"],
        "granularity": "function",
        "memory_provider": "basic-memory",
        "judge_model": "vendor/test-judge-model",
        "openrouter_key_file": str(key_file),
        "run_client_exec": False,
    }
    defaults.update(kwargs)
    return Path(perform_install(str(tmp_path), **defaults))


def test_install_builds_the_full_tree_with_correct_modes(tmp_path: Path) -> None:
    # arrange / act
    root = _install(tmp_path)
    # assert
    for private in ("token", ".env", "openrouter-key", "docker-compose.yml"):
        path = root / private
        assert path.exists(), f"missing {private}"
        assert (path.stat().st_mode & 0o777) == 0o600, f"{private} must be 0600"
    for executable in ["bin/betterai-mcp-stdio"] + [
        f"hooks/{name}"
        for name in ("user-prompt-submit", "pre-tool-use", "post-tool-use", "stop", "session-end")
    ]:
        path = root / executable
        assert path.exists(), f"missing {executable}"
        assert (path.stat().st_mode & 0o777) == 0o755, f"{executable} must be 0755"
    for subdir in ("audit", "models", "redis", "postgres", "config", "memories-bm"):
        assert (root / subdir).is_dir()


def test_installed_env_is_fully_explicit_and_reflects_flags(tmp_path: Path) -> None:
    # arrange / act
    root = _install(tmp_path)
    # assert
    env_lines = (root / ".env").read_text().splitlines()
    keys = {line.split("=", 1)[0] for line in env_lines}
    assert set(REQUIRED_KEYS) <= keys
    env_text = "\n".join(env_lines)
    assert "BETTERAI_EDIT_GRANULARITY=function" in env_text
    assert "BETTERAI_MEMORY_PROVIDER=basic-memory" in env_text
    assert "BETTERAI_OPENROUTER_AGENT_MODEL=vendor/test-judge-model" in env_text
    assert "basic-memory" in (root / "docker-compose.yml").read_text()
    assert (root / "openrouter-key").read_text().strip() == "fixture-openrouter-key"


def test_reinstall_backs_up_env_and_keeps_token(tmp_path: Path) -> None:
    # arrange
    root = _install(tmp_path)
    token_before = (root / "token").read_text()
    # act
    _install(tmp_path, granularity="none", memory_provider="none")
    # assert
    backups = list(root.glob(".env.bak.*"))
    assert len(backups) == 1
    assert (root / "token").read_text() == token_before
    assert "BETTERAI_EDIT_GRANULARITY=none" in (root / ".env").read_text()


def test_no_generated_file_contains_the_token_value(tmp_path: Path) -> None:
    # arrange / act
    root = _install(tmp_path)
    token_value = (root / "token").read_text().strip()
    # assert
    for path in tmp_path.rglob("*"):
        if path.is_file() and path != root / "token":
            assert token_value not in path.read_text(), f"token leaked into {path}"
