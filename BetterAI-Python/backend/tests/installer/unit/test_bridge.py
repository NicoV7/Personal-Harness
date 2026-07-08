"""Stdio bridge: Supergateway pass-through with runtime token read."""

from __future__ import annotations

from pathlib import Path

from app.installer.bridge import write_bridge


def test_bridge_targets_supergateway_streamable_http(tmp_path: Path) -> None:
    # arrange / act
    path = Path(write_bridge(str(tmp_path)))
    # assert
    body = path.read_text()
    assert path == tmp_path / ".betterai" / "bin" / "betterai-mcp-stdio"
    assert (path.stat().st_mode & 0o777) == 0o755
    assert "supercorp/supergateway:3.4.3" in body
    assert "--streamableHttp" in body
    assert "http://host.docker.internal:7777/mcp" in body


def test_bridge_never_embeds_the_token_value(tmp_path: Path) -> None:
    # arrange
    root = tmp_path / ".betterai"
    root.mkdir(parents=True)
    (root / "token").write_text("fixture-secret-token-value\n")
    # act
    body = Path(write_bridge(str(tmp_path))).read_text()
    # assert
    assert "fixture-secret-token-value" not in body
    assert '$(cat "$BETTERAI_HOME/token")' in body
