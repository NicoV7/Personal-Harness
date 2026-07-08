"""start_container — bring the local stack up via `docker compose`.

WHY subprocess over httpx-on-the-docker-socket: compose semantics
(multi-service dependency ordering, healthcheck waiting) live in the
compose CLI; reimplementing them over the raw Engine API would be a
second compose. `up -d --wait` is a SINGLE bounded attempt — the CLI
blocks until every service is healthy or reports failure — which is the
one-attempt shape fail-loud-no-retries requires: no polling loop here,
BAI-606 on any failure. The daemon socket comes from settings via
`docker --host unix://...` so no environment is read outside settings.
"""

from __future__ import annotations

import asyncio
import json
import subprocess

from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.mcp.start_container.schema import StartContainerInput
from app.settings import Settings

NAME = "start_container"
DESCRIPTION = (
    "Start the BetterAI local stack (redis, postgres, server) via docker "
    "compose and report per-service health. Call this when another tool "
    "failed with BAI-601 (stack unreachable)."
)


async def handle(
    input: StartContainerInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    settings = deps.settings
    await asyncio.to_thread(_run_compose, settings, ("up", "-d", "--wait"))
    listing = await asyncio.to_thread(
        _run_compose, settings, ("ps", "--all", "--format", "json")
    )
    services = _parse_services(listing.stdout)
    deps.audit.record("container_start", {"services": services}, meta)
    return {"services": services}


def _run_compose(
    settings: Settings, args: tuple[str, ...]
) -> subprocess.CompletedProcess[str]:
    command = [
        "docker",
        "--host",
        f"unix://{settings.docker_sock}",
        "compose",
        "-f",
        settings.compose_file,
        *args,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise Errors.container_op_failed(f"could not execute docker CLI: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise Errors.container_op_failed(
            f"`{' '.join(command)}` exited {result.returncode}: {detail}"
        )
    return result


def _parse_services(stdout: str) -> dict[str, str]:
    services: dict[str, str] = {}
    for entry in _decode_ps_output(stdout):
        name = entry.get("Service") or entry.get("Name") or "unknown"
        status = entry.get("Health") or entry.get("State") or entry.get("Status")
        services[str(name)] = str(status or "unknown")
    return services


def _decode_ps_output(stdout: str) -> list[dict]:
    """`docker compose ps --format json` emits a JSON array on older
    releases and one JSON object per line on newer ones; accept both."""
    text = stdout.strip()
    if not text:
        return []
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        return [_decode_ps_line(line) for line in text.splitlines() if line.strip()]
    return loaded if isinstance(loaded, list) else [loaded]


def _decode_ps_line(line: str) -> dict:
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise Errors.container_op_failed(
            f"unparseable `docker compose ps` output: {line!r}"
        ) from exc
