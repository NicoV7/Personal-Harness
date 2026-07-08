"""SessionStore protocol: all per-session gate/handler state lives behind
this seam. v1 ships the in-memory implementation; a Redis-backed store
(pre-tool materialization) is a planned drop-in — gates depend on the
protocol, never on a concrete store.

Namespaces keep handlers from colliding: each gate owns one namespace
(e.g. "read_gate", "edit_budget"). `begin_turn` clears turn-scoped
namespaces; `clear_session` removes everything for the session.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol


class SessionStore(Protocol):
    def get(self, session_id: str, namespace: str, key: str) -> Any | None: ...

    def set(self, session_id: str, namespace: str, key: str, value: Any) -> None: ...

    def delete(self, session_id: str, namespace: str, key: str) -> None: ...

    def namespace(self, session_id: str, namespace: str) -> dict[str, Any]: ...

    def begin_turn(self, session_id: str, turn_namespaces: tuple[str, ...]) -> None: ...

    def clear_session(self, session_id: str) -> None: ...


class InMemorySessionStore:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)

    def get(self, session_id: str, namespace: str, key: str) -> Any | None:
        return self._data[session_id].get(namespace, {}).get(key)

    def set(self, session_id: str, namespace: str, key: str, value: Any) -> None:
        self._data[session_id].setdefault(namespace, {})[key] = value

    def delete(self, session_id: str, namespace: str, key: str) -> None:
        self._data[session_id].get(namespace, {}).pop(key, None)

    def namespace(self, session_id: str, namespace: str) -> dict[str, Any]:
        return dict(self._data[session_id].get(namespace, {}))

    def begin_turn(self, session_id: str, turn_namespaces: tuple[str, ...]) -> None:
        for name in turn_namespaces:
            self._data[session_id].pop(name, None)

    def clear_session(self, session_id: str) -> None:
        self._data.pop(session_id, None)
