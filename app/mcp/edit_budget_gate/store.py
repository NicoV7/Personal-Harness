"""Edit-budget counters over the SessionStore protocol.

Turn-scoped (namespace listed in registry TURN_NAMESPACES): every prompt
grants a fresh budget. Counters are recorded on PostToolUse, not on the
PreToolUse allow path, so calls denied by other gates never consume the
budget (a denied call changed nothing).
"""

from __future__ import annotations

import os

from app.hooks.state import SessionStore

NAMESPACE = "edit_budget"
MUTATIONS_KEY = "mutations"
FILES_KEY = "files"


def record_mutation(store: SessionStore, session_id: str | None, paths: list[str]) -> None:
    if not session_id:
        return
    count = mutation_count(store, session_id)
    store.set(session_id, NAMESPACE, MUTATIONS_KEY, count + 1)
    files = touched_files(store, session_id)
    for path in paths:
        normalized = os.path.normpath(path)
        if normalized not in files:
            files.append(normalized)
    store.set(session_id, NAMESPACE, FILES_KEY, files)


def mutation_count(store: SessionStore, session_id: str | None) -> int:
    if not session_id:
        return 0
    return int(store.get(session_id, NAMESPACE, MUTATIONS_KEY) or 0)


def touched_files(store: SessionStore, session_id: str | None) -> list[str]:
    if not session_id:
        return []
    return list(store.get(session_id, NAMESPACE, FILES_KEY) or [])
