"""SessionStore protocol: all per-session gate/handler state lives behind
this seam. v1 ships the in-memory implementation; a Redis-backed store
(pre-tool materialization) is a planned drop-in — gates depend on the
protocol, never on a concrete store.

Namespaces keep handlers from colliding: each gate owns one namespace
(e.g. "read_gate", "edit_budget"). `begin_turn` clears turn-scoped
namespaces; `clear_session` removes everything for the session.
"""

from __future__ import annotations

from typing import Any, Protocol

# Implementation bound, not behavior config: sessions whose SessionEnd
# never arrives (crashes, unwired clients) would otherwise leak forever.
MAX_SESSIONS = 1024


class SessionStore(Protocol):
    def get(self, session_id: str, namespace: str, key: str) -> Any | None: ...

    def set(self, session_id: str, namespace: str, key: str, value: Any) -> None: ...

    def delete(self, session_id: str, namespace: str, key: str) -> None: ...

    def namespace(self, session_id: str, namespace: str) -> dict[str, Any]: ...

    def begin_turn(self, session_id: str, turn_namespaces: tuple[str, ...]) -> None: ...

    def clear_session(self, session_id: str) -> None: ...

    def session_count(self) -> int: ...


class InMemorySessionStore:
    """LRU-bounded store: only writes create a session bucket (reads on an
    unknown session never materialize state), and the least-recently-active
    session is evicted once `max_sessions` is exceeded."""

    def __init__(self, max_sessions: int = MAX_SESSIONS) -> None:
        self._max_sessions = max_sessions
        self._data: dict[str, dict[str, dict[str, Any]]] = {}

    def get(self, session_id: str, namespace: str, key: str) -> Any | None:
        return self._data.get(session_id, {}).get(namespace, {}).get(key)

    def set(self, session_id: str, namespace: str, key: str, value: Any) -> None:
        self._touch(session_id).setdefault(namespace, {})[key] = value

    def delete(self, session_id: str, namespace: str, key: str) -> None:
        bucket = self._data.get(session_id)
        if bucket is not None:
            bucket.get(namespace, {}).pop(key, None)

    def namespace(self, session_id: str, namespace: str) -> dict[str, Any]:
        return dict(self._data.get(session_id, {}).get(namespace, {}))

    def begin_turn(self, session_id: str, turn_namespaces: tuple[str, ...]) -> None:
        bucket = self._data.get(session_id)
        if bucket is None:
            return
        self._touch(session_id)
        for name in turn_namespaces:
            bucket.pop(name, None)

    def clear_session(self, session_id: str) -> None:
        self._data.pop(session_id, None)

    def session_count(self) -> int:
        return len(self._data)

    def _touch(self, session_id: str) -> dict[str, dict[str, Any]]:
        # Dict move-to-end keeps insertion order = recency order (O(1) LRU).
        bucket = self._data.pop(session_id, None) or {}
        self._data[session_id] = bucket
        while len(self._data) > self._max_sessions:
            self._data.pop(next(iter(self._data)))
        return bucket
