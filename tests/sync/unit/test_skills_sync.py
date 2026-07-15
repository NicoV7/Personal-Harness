"""SkillsSync: tarball landing, ETag short-circuit, guards, TTL gating."""

from __future__ import annotations

import asyncio
import io
import json
import tarfile
import time
from pathlib import Path

import httpx
import pytest

from app.errors import SkillsSyncError
from app.sync.skills import SkillsSync, tarball_url
from tests.mcp.gate_helpers import FakeCorpus, make_deps, make_settings, make_skill

REPO = "https://github.com/test/skills"

SKILL_MD = """---
id: synced-skill
title: Synced skill
category: testing
---

Use composition.
"""

INVALID_MD = "no frontmatter here"


def _targz(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name=f"skills-main/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _serving(content: bytes, headers: dict | None = None):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=content, headers=headers or {})

    return httpx.MockTransport(handler), requests


def _sync_deps(tmp_path, *, transport, corpus=None, ttl=3600):
    settings = make_settings(tmp_path, skills_repo_url=REPO, skills_sync_ttl=ttl)
    return make_deps(
        tmp_path, settings=settings, corpus=corpus, sync=SkillsSync(transport=transport)
    )


def _write_marker(deps, state: dict) -> Path:
    marker = Path(deps.settings.corpus_root) / "_meta" / "skills-sync.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(state), encoding="utf-8")
    return marker


def test_tarball_url_derivation():
    # arrange / act / assert
    assert tarball_url(REPO) == "https://codeload.github.com/test/skills/tar.gz/refs/heads/main"
    with pytest.raises(SkillsSyncError):
        tarball_url("https://gitlab.example/owner/repo")


async def test_run_now_lands_files_and_stamps_marker(tmp_path):
    # arrange
    transport, _ = _serving(
        _targz({"skills/testing/synced-skill.md": SKILL_MD}), {"etag": '"v1"'}
    )
    deps = _sync_deps(tmp_path, transport=transport)

    # act
    summary = await deps.sync.run_now(deps)

    # assert
    landed = (
        Path(deps.settings.corpus_root)
        / "skills"
        / "synced-github"
        / "testing"
        / "synced-skill.md"
    )
    assert summary == {"status": "ok", "written": 1, "url": REPO}
    assert landed.read_text(encoding="utf-8") == SKILL_MD
    marker = json.loads(
        (Path(deps.settings.corpus_root) / "_meta" / "skills-sync.json").read_text()
    )
    assert marker["status"] == "ok"
    assert marker["etag"] == '"v1"'


async def test_etag_304_short_circuits(tmp_path):
    # arrange
    sent: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers.get("if-none-match"))
        return httpx.Response(304)

    deps = _sync_deps(tmp_path, transport=httpx.MockTransport(handler))
    _write_marker(deps, {"ts": 0, "etag": '"v1"', "status": "ok"})

    # act
    summary = await deps.sync.run_now(deps)

    # assert
    assert sent == ['"v1"']
    assert summary["status"] == "unchanged"


async def test_invalid_artifact_aborts_whole_sync(tmp_path):
    # arrange
    transport, _ = _serving(
        _targz({"skills/good.md": SKILL_MD, "skills/bad.md": INVALID_MD})
    )
    deps = _sync_deps(tmp_path, transport=transport)

    # act / assert: nothing lands, not even the valid file
    with pytest.raises(SkillsSyncError):
        await deps.sync.run_now(deps)
    assert not (Path(deps.settings.corpus_root) / "skills" / "synced-github").exists()


async def test_collision_with_user_artifact_aborts(tmp_path):
    # arrange
    transport, _ = _serving(_targz({"skills/synced-skill.md": SKILL_MD}))
    deps = _sync_deps(
        tmp_path, transport=transport, corpus=FakeCorpus([make_skill("synced-skill")])
    )

    # act / assert
    with pytest.raises(SkillsSyncError):
        await deps.sync.run_now(deps)


async def test_off_disables_run_now_and_status_line(tmp_path):
    # arrange: gate_helpers default settings have skills_repo_url="off"
    deps = make_deps(tmp_path)

    # act / assert
    assert await deps.sync.run_now(deps) == {"status": "off", "written": 0}
    assert deps.sync.ensure_fresh(deps) is None


async def test_ensure_fresh_within_ttl_reports_age_without_fetching(tmp_path):
    # arrange
    transport, requests = _serving(_targz({}))
    deps = _sync_deps(tmp_path, transport=transport)
    _write_marker(deps, {"ts": time.time() - 60, "etag": None, "status": "ok"})

    # act
    line = deps.sync.ensure_fresh(deps)

    # assert
    assert "last refresh" in line
    assert requests == []


async def test_ensure_fresh_stale_schedules_background_refresh(tmp_path):
    # arrange
    transport, requests = _serving(_targz({"skills/testing/synced-skill.md": SKILL_MD}))
    deps = _sync_deps(tmp_path, transport=transport, ttl=1)
    _write_marker(deps, {"ts": time.time() - 7200, "etag": None, "status": "ok"})

    # act
    line = deps.sync.ensure_fresh(deps)
    for _ in range(50):
        if requests:
            break
        await asyncio.sleep(0.01)

    # assert
    assert "background" in line
    assert requests


async def test_failure_is_recorded_and_reported_next_turn(tmp_path):
    # arrange
    deps = _sync_deps(
        tmp_path, transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )

    # act
    with pytest.raises(SkillsSyncError):
        await deps.sync.run_now(deps)
    line = deps.sync.ensure_fresh(deps)

    # assert: one attempt per TTL window, loud status line meanwhile
    assert "FAILED [BAI-610]" in line
