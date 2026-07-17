"""perform_install key handling + postgres password preservation.

Throwaway HOME per test (the install-smoke convention); no docker, no
client exec, no network — perform_install is pure filesystem here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.cli import _read_env_value, perform_install
from app.errors import ConfigInvalidError


def _install(home: Path, **kwargs) -> Path:
    perform_install(
        str(home),
        clients=["claude"],
        granularity="none",
        memory_provider="none",
        judge_model="test/judge-model",
        run_client_exec=False,
        **kwargs,
    )
    return home / ".betterai"


def test_inline_key_is_written_0600(tmp_path):
    # act
    root = _install(tmp_path, openrouter_key="sk-or-inline-value")

    # assert
    key_path = root / "openrouter-key"
    assert key_path.read_text() == "sk-or-inline-value\n"
    assert (key_path.stat().st_mode & 0o777) == 0o600


def test_key_file_wins_over_inline_value(tmp_path):
    # arrange
    source = tmp_path / "key-source"
    source.write_text("sk-or-from-file\n")

    # act
    root = _install(tmp_path, openrouter_key_file=str(source), openrouter_key="sk-or-inline")

    # assert
    assert (root / "openrouter-key").read_text() == "sk-or-from-file\n"


def test_no_key_installs_degraded_without_key_file(tmp_path):
    # act
    root = _install(tmp_path)

    # assert: no key file, but the tree and .env are complete
    assert not (root / "openrouter-key").exists()
    assert (root / ".env").exists()
    assert (root / "token").exists()


def test_unreadable_key_file_fails_loud(tmp_path):
    # act / assert
    with pytest.raises(ConfigInvalidError, match="--openrouter-key-file"):
        _install(tmp_path, openrouter_key_file=str(tmp_path / "missing"))


def test_reinstall_preserves_postgres_password(tmp_path):
    # arrange: first install mints a password the pg volume will keep
    root = _install(tmp_path, openrouter_key="sk-or-x")
    first_password = _read_env_value(root / ".env", "BETTERAI_POSTGRES_PASSWORD")
    assert first_password

    # act: deliberate re-install
    _install(tmp_path, openrouter_key="sk-or-x")

    # assert: password and DSN survive, so the volume is never orphaned
    assert _read_env_value(root / ".env", "BETTERAI_POSTGRES_PASSWORD") == first_password
    assert first_password in _read_env_value(root / ".env", "BETTERAI_POSTGRES_DSN")
