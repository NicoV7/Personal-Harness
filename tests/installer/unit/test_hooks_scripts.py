"""Host hook scripts: all five events, executable, fail-open on
transport errors, block only on an explicit server answer."""

from __future__ import annotations

from pathlib import Path

from app.installer.hooks_scripts import HOOK_NAMES, write_hook_scripts


def test_writes_all_five_hook_scripts_including_post_tool_use(tmp_path: Path) -> None:
    # arrange / act
    written = write_hook_scripts(str(tmp_path))
    # assert
    names = sorted(Path(path).name for path in written)
    assert names == sorted(HOOK_NAMES)
    assert "post-tool-use" in names
    for path in written:
        assert (Path(path).stat().st_mode & 0o777) == 0o755


def test_scripts_always_exit_zero_and_log_real_curl_failures(tmp_path: Path) -> None:
    # arrange / act
    write_hook_scripts(str(tmp_path))
    # assert: the client only processes hook JSON at exit 0, so deny/block
    # travels in the printed body — never via exit 2
    for name in HOOK_NAMES:
        body = (tmp_path / ".betterai" / "hooks" / name).read_text()
        assert "hook-errors.log" in body, f"{name} must log transport failures"
        assert "--connect-timeout 2" in body and "--max-time 5" in body
        assert "exit 2" not in body
        assert body.rstrip().endswith("exit 0")
        assert "CURL_EXIT=$?" in body, f"{name} must capture curl's real exit code"
        assert f"http://127.0.0.1:7777/hooks/{name}" in body
        assert "Authorization: Bearer" in body


def test_only_post_tool_use_attaches_plan_content(tmp_path: Path) -> None:
    # arrange / act
    write_hook_scripts(str(tmp_path))
    # assert: the plan-content snippet rides exactly one script, fail-open
    for name in HOOK_NAMES:
        body = (tmp_path / ".betterai" / "hooks" / name).read_text()
        if name == "post-tool-use":
            assert "plan_content" in body
            assert "*/.claude/plans/*.md" in body
            assert "|| true" in body
        else:
            assert "plan_content" not in body


def test_scripts_read_token_at_runtime_never_embed_it(tmp_path: Path) -> None:
    # arrange
    token_dir = tmp_path / ".betterai"
    token_dir.mkdir(parents=True)
    (token_dir / "token").write_text("fixture-secret-token-value\n")
    # act
    written = write_hook_scripts(str(tmp_path))
    # assert
    for path in written:
        assert "fixture-secret-token-value" not in Path(path).read_text()
