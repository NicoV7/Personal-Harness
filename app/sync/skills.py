"""GitHub skills sync: codeload tarball -> validate -> land -> reindex.

Stale-while-revalidate: the prompt hook calls ensure_fresh() every turn;
it never blocks or raises — once the last attempt is older than the TTL
it schedules ONE background run and reports a one-line status. A tarball
(not git) keeps the corpus free of mutable derived state (.git) and the
image free of a git binary; the stored ETag makes the common case a 304.
One attempt per TTL window, failures recorded loudly (no retries).
"""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import tarfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from app.corpus.reader import parse_artifact_text
from app.corpus.schema import Artifact
from app.errors import BetterAIError, Errors

if TYPE_CHECKING:
    from app.deps import Deps

FETCH_TIMEOUT_SECONDS = 30.0
SYNC_DIR = "synced-github"
MARKER_FILE = "skills-sync.json"
_ARTIFACT_TYPES = {"rules": "rule", "skills": "skill"}
_FILE_MODE = 0o640

# (artifact_dir, relative_path, raw_text, parsed_artifact)
Entry = tuple[str, str, str, Artifact]


def tarball_url(repo_url: str) -> str:
    path = repo_url.removeprefix("https://github.com/").strip("/")
    parts = path.split("/")
    if repo_url.startswith("https://github.com/") and len(parts) == 2 and all(parts):
        return f"https://codeload.github.com/{parts[0]}/{parts[1]}/tar.gz/refs/heads/main"
    raise Errors.skills_sync_failed(repo_url, "expected https://github.com/<owner>/<repo>")


class SkillsSync:
    """Per-process sync state; heavy collaborators arrive per call via Deps."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport
        self._state: dict[str, Any] | None = None
        self._state_loaded = False
        self._in_flight = False

    def ensure_fresh(self, deps: Deps) -> str | None:
        """One-line status for the prompt hook; schedules a background
        refresh when stale. Never blocks the serve path."""
        if deps.settings.skills_repo_url == "off":
            return None
        state = self._load_state(deps)
        if self._in_flight:
            return "BetterAI skills sync: refresh in progress."
        age = None if state is None else max(time.time() - float(state.get("ts", 0)), 0.0)
        if age is not None and age < deps.settings.skills_sync_ttl:
            if state.get("status") == "failed":
                return (
                    f"BetterAI skills sync FAILED [BAI-610]: {state.get('error')} — "
                    "serving the existing corpus (betterai sync to retry)."
                )
            return f"BetterAI skills sync: last refresh {_format_age(age)} ago."
        self._in_flight = True
        asyncio.get_running_loop().create_task(self._run_guarded(deps))
        return "BetterAI skills sync: refresh started in the background."

    async def run_now(self, deps: Deps) -> dict:
        """Forcing entry point for `betterai sync` / POST /sync: raises typed
        errors; every attempt (pass or fail) is audited and stamped."""
        url = deps.settings.skills_repo_url
        if url == "off":
            return {"status": "off", "written": 0}
        try:
            summary = await self._sync(deps, url)
        except BetterAIError as error:
            self._save_state(
                deps,
                {
                    "ts": time.time(),
                    "etag": self._etag(deps),
                    "status": "failed",
                    "error": str(error),
                },
            )
            deps.audit.record(
                "skills_sync", {"status": "failed", "url": url, "error": str(error)}
            )
            raise
        deps.audit.record("skills_sync", summary)
        return summary

    async def _run_guarded(self, deps: Deps) -> None:
        try:
            await self.run_now(deps)
        except BetterAIError:
            pass  # recorded by run_now; the next prompt's status line reports it
        finally:
            self._in_flight = False

    async def _sync(self, deps: Deps, url: str) -> dict:
        response = await self._fetch(url, self._etag(deps))
        if response.status_code == 304:
            self._save_state(
                deps, {"ts": time.time(), "etag": self._etag(deps), "status": "unchanged"}
            )
            return {"status": "unchanged", "written": 0, "url": url}
        entries = _parse_archive(url, response.content)
        _guard_collisions(deps, url, entries)
        written = _land(deps, entries)
        await deps.pipeline.index_corpus(deps.corpus.read())
        self._save_state(
            deps,
            {
                "ts": time.time(),
                "etag": response.headers.get("etag"),
                "status": "ok",
                "written": written,
            },
        )
        return {"status": "ok", "written": written, "url": url}

    async def _fetch(self, url: str, etag: str | None) -> httpx.Response:
        target = tarball_url(url)
        headers = {"If-None-Match": etag} if etag else {}
        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=FETCH_TIMEOUT_SECONDS,
                transport=self._transport,
            ) as client:
                response = await client.get(target, headers=headers)
        except httpx.HTTPError as error:
            raise Errors.skills_sync_failed(target, str(error)) from error
        if response.status_code not in (200, 304):
            raise Errors.skills_sync_failed(target, f"HTTP {response.status_code}")
        return response

    def _etag(self, deps: Deps) -> str | None:
        state = self._load_state(deps)
        return state.get("etag") if state else None

    def _load_state(self, deps: Deps) -> dict[str, Any] | None:
        if not self._state_loaded:
            self._state_loaded = True
            try:
                parsed = json.loads(_marker_path(deps).read_text(encoding="utf-8"))
                self._state = parsed if isinstance(parsed, dict) else None
            except (OSError, ValueError):
                self._state = None
        return self._state

    def _save_state(self, deps: Deps, state: dict[str, Any]) -> None:
        self._state = state
        self._state_loaded = True
        marker = _marker_path(deps)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(state), encoding="utf-8")


def _marker_path(deps: Deps) -> Path:
    # _meta/ is pruned by CorpusReader walks, so the marker never parses.
    return Path(deps.settings.corpus_root) / "_meta" / MARKER_FILE


def _parse_archive(url: str, content: bytes) -> list[Entry]:
    """Every rules/skills .md in the archive, each validated as an
    Artifact — one invalid file aborts the whole sync, corpus untouched."""
    entries: list[Entry] = []
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as tar:
            for member in tar.getmembers():
                if not member.isfile() or not member.name.endswith(".md"):
                    continue
                parts = Path(member.name).parts[1:]  # drop the "<repo>-<ref>/" root
                if any(part == ".." for part in Path(member.name).parts):
                    raise Errors.skills_sync_failed(url, f"unsafe path {member.name!r}")
                if len(parts) < 2 or parts[0] not in _ARTIFACT_TYPES:
                    continue
                handle = tar.extractfile(member)
                if handle is None:
                    continue
                text = handle.read().decode("utf-8")
                rel = str(Path(*parts[1:]))
                artifact = _validated(url, parts[0], rel, text)
                entries.append((parts[0], rel, text, artifact))
    except (tarfile.TarError, UnicodeDecodeError, OSError) as error:
        raise Errors.skills_sync_failed(url, f"unreadable archive: {error}") from error
    return entries


def _validated(url: str, artifact_dir: str, rel: str, text: str) -> Artifact:
    try:
        return parse_artifact_text(
            text,
            artifact_type=_ARTIFACT_TYPES[artifact_dir],
            scope="global",
            source_path=f"{url}:{artifact_dir}/{rel}",
        )
    except BetterAIError as error:
        raise Errors.skills_sync_failed(url, str(error)) from error


def _guard_collisions(deps: Deps, url: str, entries: list[Entry]) -> None:
    """Never clobber user-authored artifacts: a synced id already living
    outside the synced-github dirs aborts the whole sync."""
    synced_ids = {artifact.id for _, _, _, artifact in entries}
    marker = f"/{SYNC_DIR}/"
    for existing in deps.corpus.read():
        if existing.id in synced_ids and marker not in (existing.source_path or ""):
            raise Errors.skills_sync_failed(
                url,
                f"id {existing.id!r} already exists outside {SYNC_DIR}; rename it upstream",
            )


def _land(deps: Deps, entries: list[Entry]) -> int:
    """Replace-on-sync into the dedicated synced-github namespaces, so
    files removed upstream disappear locally too."""
    root = Path(deps.settings.corpus_root)
    for artifact_dir in _ARTIFACT_TYPES:
        target = root / artifact_dir / SYNC_DIR
        if target.exists():
            shutil.rmtree(target)
    for artifact_dir, rel, text, _ in entries:
        path = root / artifact_dir / SYNC_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        path.chmod(_FILE_MODE)
    return len(entries)


def _format_age(age: float) -> str:
    seconds = int(age)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    return f"{seconds // 3600}h"
