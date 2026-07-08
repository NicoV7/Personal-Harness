"""Plan-manifest state + path matching over the SessionStore protocol.

The namespace is deliberately NOT in registry TURN_NAMESPACES: a plan's
touch set persists across turns until the session ends, because the plan
governs the whole task, not one prompt. Path matching is lenient about
relative vs absolute (suffix match) because hook payloads carry absolute
client paths while plans usually list repo-relative ones.
"""

from __future__ import annotations

import os
from fnmatch import fnmatch

from app.hooks.state import SessionStore
from app.mcp.plan_manifest_gate.parser import ManifestEntry

NAMESPACE = "plan_manifest"
ENTRIES_KEY = "entries"
ACTIVE_KEY = "active"
DIR_GLOB_SUFFIX = "/**"


def register(store: SessionStore, session_id: str | None, entries: list[dict]) -> None:
    if not session_id:
        return
    store.set(session_id, NAMESPACE, ENTRIES_KEY, entries)
    store.set(session_id, NAMESPACE, ACTIVE_KEY, True)


def deactivate(store: SessionStore, session_id: str | None) -> None:
    if not session_id:
        return
    store.set(session_id, NAMESPACE, ACTIVE_KEY, False)


def clear(store: SessionStore, session_id: str | None) -> None:
    if not session_id:
        return
    store.delete(session_id, NAMESPACE, ENTRIES_KEY)
    store.delete(session_id, NAMESPACE, ACTIVE_KEY)


def is_active(store: SessionStore, session_id: str | None) -> bool:
    if not session_id:
        return False
    return bool(store.get(session_id, NAMESPACE, ACTIVE_KEY))


def entries(store: SessionStore, session_id: str | None) -> list[dict]:
    if not session_id:
        return []
    return list(store.get(session_id, NAMESPACE, ENTRIES_KEY) or [])


def entry_to_dict(entry: ManifestEntry, cwd: str | None = None) -> dict:
    return {
        "path": normalize_path(entry.path, cwd),
        "functions": entry.functions,
        "justified": entry.justified,
    }


def normalize_path(path: str, cwd: str | None = None) -> str:
    """Absolute when a cwd lets us resolve; otherwise kept as given so
    the matcher can fall back to suffix matching."""
    cleaned = os.path.normpath(path.strip())
    if cwd and not os.path.isabs(cleaned):
        return os.path.normpath(os.path.join(cwd, cleaned))
    return cleaned


def path_allowed(manifest_entries: list[dict], path: str, plan_glob: str) -> bool:
    """True when the manifest is empty, the path is a plan file, or the
    path matches an entry exactly / by suffix / by declared dir glob."""
    if not manifest_entries:
        return True
    if matches_plan_glob(path, plan_glob):
        return True
    candidate = normalize_path(path)
    return any(_entry_matches(entry["path"], candidate) for entry in manifest_entries)


def matches_plan_glob(path: str, plan_glob: str) -> bool:
    candidate = normalize_path(path)
    return fnmatch(candidate, plan_glob) or fnmatch(os.path.basename(candidate), plan_glob)


def _entry_matches(entry_path: str, candidate: str) -> bool:
    entry_path = normalize_path(entry_path)
    if entry_path.endswith(DIR_GLOB_SUFFIX):
        return _under_dir(entry_path[: -len(DIR_GLOB_SUFFIX)], candidate)
    if entry_path == candidate:
        return True
    if not os.path.isabs(entry_path) and candidate.endswith(f"/{entry_path}"):
        return True
    return not os.path.isabs(candidate) and entry_path.endswith(f"/{candidate}")


def _under_dir(directory: str, candidate: str) -> bool:
    if candidate == directory or candidate.startswith(f"{directory}/"):
        return True
    return not os.path.isabs(directory) and f"/{directory}/" in candidate
