"""app/doctor.py: structured checks with fix hints, host-side only.

A throwaway HOME under tmp_path stands in for the real install tree
(same convention as the install smoke); the server probe and client
adapters are monkeypatched at their seams — doctor must never touch the
live host from tests.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import app.doctor as doctor_module
from app.doctor import failure_count, run_doctor
from app.errors import Errors
from app.settings import REQUIRED_KEYS


@dataclass(frozen=True)
class FakeClientStatus:
    client: str
    installed: bool
    detail: str = "configured"
    path: str = "~/.claude/settings.json"


def _install_tree(home: Path) -> Path:
    """A healthy ~/.betterai fixture: every file doctor inspects."""
    root = home / ".betterai"
    root.mkdir(parents=True)
    for name, body in (("token", "tok-value\n"), ("openrouter-key", "sk-or-value\n")):
        (root / name).write_text(body)
        (root / name).chmod(0o600)
    (root / "docker-compose.yml").write_text("services: {}\n")
    (root / ".env").write_text("".join(f"{key}=x\n" for key in REQUIRED_KEYS))
    bridge = root / "bin" / "betterai-mcp-stdio"
    bridge.parent.mkdir()
    bridge.write_text("#!/bin/sh\n")
    bridge.chmod(0o755)
    return root


def _patch_seams(monkeypatch, *, health_error=None):
    monkeypatch.setattr(
        doctor_module,
        "client_status",
        lambda client, home: FakeClientStatus(client=client, installed=client == "claude"),
    )

    def fake_server_get(user_home, path):
        if health_error is not None:
            raise health_error
        return {"status": "ok", "corpus_artifacts": 3, "index": {"ok": True}}

    monkeypatch.setattr(doctor_module, "server_get", fake_server_get)


def test_healthy_tree_has_zero_failures(tmp_path, monkeypatch):
    # arrange
    _install_tree(tmp_path)
    _patch_seams(monkeypatch)

    # act
    checks = run_doctor(str(tmp_path))

    # assert
    assert failure_count(checks) == 0
    by_id = {check.id: check for check in checks}
    assert by_id["key-present"].ok
    assert by_id["server-health"].ok
    assert by_id["env"].label == ".env fresh"


def test_failures_carry_fix_hints(tmp_path, monkeypatch):
    # arrange: empty HOME — everything is missing
    _patch_seams(
        monkeypatch, health_error=Errors.stack_unavailable("server", "connect refused")
    )

    # act
    checks = run_doctor(str(tmp_path))
    by_id = {check.id: check for check in checks}

    # assert
    assert failure_count(checks) > 0
    assert "betterai install" in by_id["compose-file"].fix_hint
    assert "betterai start" in by_id["server-health"].fix_hint
    assert "chmod 600" in by_id["token-mode"].fix_hint
    assert by_id["key-present"].fix_hint  # empty key file must nag


def test_empty_key_file_fails_key_present_only(tmp_path, monkeypatch):
    # arrange: healthy tree, then blank the key (degraded install mode)
    root = _install_tree(tmp_path)
    (root / "openrouter-key").write_text("   \n")
    _patch_seams(monkeypatch)

    # act
    by_id = {check.id: check for check in run_doctor(str(tmp_path))}

    # assert
    assert by_id["key-mode"].ok  # mode is still 0600
    assert not by_id["key-present"].ok
    assert "openrouter-key" in by_id["key-present"].fix_hint


def test_client_rows_are_advisory_not_failures(tmp_path, monkeypatch):
    # arrange
    _install_tree(tmp_path)
    _patch_seams(monkeypatch)

    # act
    checks = run_doctor(str(tmp_path))
    client_rows = [check for check in checks if check.id.startswith("client-")]

    # assert: codex/generic are "not installed" yet count no failures
    assert {row.id for row in client_rows} == {"client-claude", "client-codex", "client-generic"}
    assert all(row.advisory for row in client_rows)
    assert failure_count(checks) == 0


def test_stale_env_names_missing_keys(tmp_path, monkeypatch):
    # arrange
    root = _install_tree(tmp_path)
    kept = list(REQUIRED_KEYS)[:-2]
    (root / ".env").write_text("".join(f"{key}=x\n" for key in kept))
    _patch_seams(monkeypatch)

    # act
    by_id = {check.id: check for check in run_doctor(str(tmp_path))}

    # assert
    assert not by_id["env"].ok
    for missing in set(REQUIRED_KEYS) - set(kept):
        assert missing in by_id["env"].detail


def test_checks_serialize_to_json(tmp_path, monkeypatch):
    # arrange
    _install_tree(tmp_path)
    _patch_seams(monkeypatch)

    # act
    payload = json.dumps([check.as_dict() for check in run_doctor(str(tmp_path))])

    # assert: PR2's /api/local/doctor serves exactly this shape
    rows = json.loads(payload)
    assert {"id", "label", "ok", "detail", "fix_hint", "advisory"} <= set(rows[0])
