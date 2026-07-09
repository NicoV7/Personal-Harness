"""Arm runner: generate one fixture's solution in an isolated workdir.

Control runs `claude -p` with a minimal settings file and an empty
strict MCP config, so no BetterAI hooks or tools exist; treatment runs
against the user's live install. Both capture diff.patch, the JSON
transcript, and wall-clock into the EVAL-HARNESS.md run-dir layout.
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from app.errors import Errors

ARM_CONTROL = "control"
ARM_TREATMENT = "treatment"
CLAUDE_TIMEOUT_SECONDS = 1800.0


@dataclass(frozen=True)
class ArmResult:
    arm: str
    workdir: str
    diff_path: str
    transcript_path: str
    wall_seconds: float
    exit_code: int


def run_arm(fixture: dict, arm: str, run_dir: Path) -> ArmResult:
    workdir = run_dir / fixture["id"] / arm
    workdir.mkdir(parents=True, exist_ok=True)
    _git(workdir, "init", "-q")
    _git(workdir, "commit", "-q", "--allow-empty", "-m", "eval baseline")
    command = _claude_command(fixture["task_description"], arm, workdir)
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise Errors.container_op_failed(
            "the `claude` CLI is required for eval arms and was not found on PATH"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise Errors.container_op_failed(
            f"eval arm {arm} for {fixture['id']} timed out after {CLAUDE_TIMEOUT_SECONDS}s"
        ) from exc
    wall = time.monotonic() - started
    transcript_path = workdir / "transcript.json"
    transcript_path.write_text(completed.stdout or "")
    (workdir / "stderr.log").write_text(completed.stderr or "")
    _git(workdir, "add", "-A")
    diff = _git(workdir, "diff", "--cached", "--", ".", ":!transcript.json", ":!stderr.log")
    diff_path = workdir / "diff.patch"
    diff_path.write_text(diff)
    return ArmResult(
        arm=arm,
        workdir=str(workdir),
        diff_path=str(diff_path),
        transcript_path=str(transcript_path),
        wall_seconds=round(wall, 2),
        exit_code=completed.returncode,
    )


def _claude_command(task: str, arm: str, workdir: Path) -> list[str]:
    command = [
        "claude",
        "-p",
        task,
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
    ]
    if arm == ARM_CONTROL:
        empty_mcp = workdir / "control-mcp.json"
        empty_mcp.write_text(json.dumps({"mcpServers": {}}))
        minimal_settings = workdir / "control-settings.json"
        minimal_settings.write_text(json.dumps({"hooks": {}}))
        command += [
            "--strict-mcp-config",
            "--mcp-config",
            str(empty_mcp),
            "--settings",
            str(minimal_settings),
        ]
    return command


def _git(workdir: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=workdir, capture_output=True, text=True, check=False
    )
    if completed.returncode != 0:
        raise Errors.container_op_failed(
            f"git {' '.join(args)} failed in {workdir}: {completed.stderr.strip()}"
        )
    return completed.stdout
