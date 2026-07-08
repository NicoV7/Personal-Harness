"""Retrieval-receipt state helpers over the SessionStore protocol.

The receipt is turn-scoped (namespace is listed in registry
TURN_NAMESPACES) so every prompt starts unretrieved. Two writers set it:
the query_skills tool handler and the user-prompt-submit hook flow
(server-side retrieval runs there, so the receipt exists automatically
on a normal turn).
"""

from __future__ import annotations

from app.hooks.state import SessionStore

NAMESPACE = "retrieval_receipt"
RETRIEVED_KEY = "retrieved"


def mark_retrieved(store: SessionStore, session_id: str | None) -> None:
    if not session_id:
        return
    store.set(session_id, NAMESPACE, RETRIEVED_KEY, True)


def has_retrieved(store: SessionStore, session_id: str | None) -> bool:
    if not session_id:
        return False
    return bool(store.get(session_id, NAMESPACE, RETRIEVED_KEY))
