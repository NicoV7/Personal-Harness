"""Read-receipt state helpers over the SessionStore protocol.

Port of the TS ReadReceiptStore (src/runtime/read-receipts.ts). State is
kept behind SessionStore instead of module-level maps so the planned
Redis-backed store drops in without touching gate logic. A null
session_id disables gating entirely (the TS contract), so every helper
guards on it rather than forcing callers to.
"""

from __future__ import annotations

from app.hooks.state import SessionStore

NAMESPACE = "read_gate"
STOP_NAMESPACE = "stop_state"
REQUIRED_KEY = "required"
READ_KEY = "read"
BLOCKED_ONCE_KEY = "blocked_once"


def set_required(store: SessionStore, session_id: str | None, skill_ids: list[str]) -> None:
    """Replace the required set for a new turn (prompt hooks call this)."""
    if not session_id:
        return
    store.set(session_id, NAMESPACE, REQUIRED_KEY, sorted(set(skill_ids)))


def mark_required(store: SessionStore, session_id: str | None, skill_ids: list[str]) -> None:
    """Add follow-up requirements inside the current turn."""
    if not session_id or not skill_ids:
        return
    current = store.get(session_id, NAMESPACE, REQUIRED_KEY) or []
    store.set(session_id, NAMESPACE, REQUIRED_KEY, sorted(set(current) | set(skill_ids)))


def mark_read(store: SessionStore, session_id: str | None, skill_id: str) -> None:
    if not session_id:
        return
    current = store.get(session_id, NAMESPACE, READ_KEY) or []
    store.set(session_id, NAMESPACE, READ_KEY, sorted(set(current) | {skill_id}))


def missing(store: SessionStore, session_id: str | None) -> list[str]:
    """Required minus read, sorted. Empty for null sessions by contract."""
    if not session_id:
        return []
    required = store.get(session_id, NAMESPACE, REQUIRED_KEY) or []
    read = set(store.get(session_id, NAMESPACE, READ_KEY) or [])
    return sorted(skill_id for skill_id in required if skill_id not in read)


def should_block_stop_once(store: SessionStore, session_id: str | None) -> bool:
    """True exactly once per turn while skills are still missing.

    The single-shot latch exists so an agent that ignores the reminder is
    not trapped in an infinite stop loop (TS shouldBlockStopOnce).
    """
    if not session_id or not missing(store, session_id):
        return False
    if store.get(session_id, STOP_NAMESPACE, BLOCKED_ONCE_KEY):
        return False
    store.set(session_id, STOP_NAMESPACE, BLOCKED_ONCE_KEY, True)
    return True
