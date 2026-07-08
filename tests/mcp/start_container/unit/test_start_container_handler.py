"""start_container: docker CLI boundary mocked, one attempt, BAI-606."""

from __future__ import annotations

import subprocess

import pytest

from app.errors import ContainerOpError
from app.mcp.start_container import handler as start_container
from app.mcp.start_container.schema import INPUT_MODEL

PS_JSON_LINES = (
    '{"Service": "redis", "Health": "healthy", "State": "running"}\n'
    '{"Service": "postgres", "State": "running"}\n'
)


def _fake_run(calls, ps_stdout=PS_JSON_LINES, up_returncode=0):
    def run(command, capture_output, text, check):
        calls.append(command)
        if "up" in command:
            return subprocess.CompletedProcess(command, up_returncode, "", "boom")
        return subprocess.CompletedProcess(command, 0, ps_stdout, "")

    return run


class TestStartContainer:
    async def test_up_then_ps_and_service_statuses_returned(
        self, deps, meta, monkeypatch, read_audit
    ):
        # arrange
        calls: list[list[str]] = []
        monkeypatch.setattr(start_container.subprocess, "run", _fake_run(calls))
        # act
        out = await start_container.handle(INPUT_MODEL(), deps, meta)
        # assert
        assert out == {"services": {"redis": "healthy", "postgres": "running"}}
        up_command, ps_command = calls
        assert up_command[:3] == ["docker", "--host", f"unix://{deps.settings.docker_sock}"]
        assert up_command[3:] == [
            "compose", "-f", deps.settings.compose_file, "up", "-d", "--wait",
        ]
        assert ps_command[-3:] == ["--all", "--format", "json"]
        event = read_audit()[-1]
        assert event["event_type"] == "container_start"
        assert event["payload"]["services"]["redis"] == "healthy"

    async def test_json_array_ps_output_also_parses(self, deps, meta, monkeypatch):
        # arrange
        calls: list[list[str]] = []
        array_output = '[{"Service": "redis", "Health": "healthy"}]'
        monkeypatch.setattr(
            start_container.subprocess, "run", _fake_run(calls, ps_stdout=array_output)
        )
        # act
        out = await start_container.handle(INPUT_MODEL(), deps, meta)
        # assert
        assert out["services"] == {"redis": "healthy"}

    async def test_nonzero_exit_raises_bai_606_with_stderr(
        self, deps, meta, monkeypatch
    ):
        # arrange
        calls: list[list[str]] = []
        monkeypatch.setattr(
            start_container.subprocess, "run", _fake_run(calls, up_returncode=1)
        )
        # act
        with pytest.raises(ContainerOpError) as excinfo:
            await start_container.handle(INPUT_MODEL(), deps, meta)
        # assert (single attempt: no second `up` call happened)
        assert excinfo.value.code == "BAI-606"
        assert "boom" in str(excinfo.value)
        assert len(calls) == 1

    async def test_missing_docker_binary_raises_bai_606(self, deps, meta, monkeypatch):
        # arrange
        def raise_oserror(command, capture_output, text, check):
            raise FileNotFoundError("docker not found")

        monkeypatch.setattr(start_container.subprocess, "run", raise_oserror)
        # act / assert
        with pytest.raises(ContainerOpError):
            await start_container.handle(INPUT_MODEL(), deps, meta)
