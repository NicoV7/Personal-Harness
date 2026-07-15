"""Auto-accept skill reads: permissions.allow management in the Claude
adapter. Install pins the read-only betterai tools, uninstall removes
only ours, and a wrong-typed permissions block fails loud (never
clobber the user's settings.json).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.errors import ConfigInvalidError
from app.installer.adapters import AUTO_ALLOWED_TOOLS, install_client, uninstall_client


def _settings_path(home: Path) -> Path:
    return home / ".claude" / "settings.json"


def _write_settings(home: Path, value: dict) -> None:
    path = _settings_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def _read_settings(home: Path) -> dict:
    return json.loads(_settings_path(home).read_text())


def _install(home: Path) -> None:
    install_client("claude", str(home), run_client_exec=False)


class TestAutoAllowedPermissions:
    def test_install_adds_all_read_only_skill_tools(self, tmp_path):
        # arrange / act
        _install(tmp_path)

        # assert
        allow = _read_settings(tmp_path)["permissions"]["allow"]
        assert list(AUTO_ALLOWED_TOOLS) == [e for e in allow if e.startswith("mcp__betterai__")]
        assert "mcp__betterai__edit_skill" not in allow  # mutating tools stay prompted

    def test_reinstall_is_idempotent(self, tmp_path):
        # arrange
        _install(tmp_path)

        # act
        _install(tmp_path)

        # assert
        allow = _read_settings(tmp_path)["permissions"]["allow"]
        assert len(allow) == len(set(allow)) == len(AUTO_ALLOWED_TOOLS)

    def test_user_permission_entries_survive_install_and_uninstall(self, tmp_path):
        # arrange
        _write_settings(
            tmp_path, {"permissions": {"allow": ["Bash(npm test:*)"], "deny": ["WebFetch"]}}
        )

        # act
        _install(tmp_path)
        uninstall_client("claude", str(tmp_path))

        # assert
        permissions = _read_settings(tmp_path)["permissions"]
        assert permissions["allow"] == ["Bash(npm test:*)"]
        assert permissions["deny"] == ["WebFetch"]

    def test_uninstall_removes_only_betterai_entries(self, tmp_path):
        # arrange
        _install(tmp_path)

        # act
        uninstall_client("claude", str(tmp_path))

        # assert
        allow = _read_settings(tmp_path)["permissions"]["allow"]
        assert not [e for e in allow if e.startswith("mcp__betterai__")]

    def test_wrong_typed_permissions_block_fails_loud(self, tmp_path):
        # arrange
        _write_settings(tmp_path, {"permissions": "readonly"})

        # act / assert
        with pytest.raises(ConfigInvalidError):
            _install(tmp_path)

    def test_wrong_typed_allow_list_fails_loud(self, tmp_path):
        # arrange
        _write_settings(tmp_path, {"permissions": {"allow": {"tool": "x"}}})

        # act / assert
        with pytest.raises(ConfigInvalidError):
            _install(tmp_path)
