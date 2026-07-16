"""Shared dependency container + per-call metadata (CROSS-MODULE CONTRACT).

Every tool handler receives `(input, deps: Deps, meta: CallMeta,
on_progress: ProgressFn | None)`. This module must match the shapes the
other build agents compile against, so it stays import-light: the
retrieval pipeline is only imported for type checking (it is built by a
parallel agent and may not exist yet at import time).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.audit import AuditLog
    from app.corpus.reader import CorpusReader
    from app.hooks.plan_cache import PlanSkillCache
    from app.hooks.state import SessionStore
    from app.openrouter import ChatClientProvider
    from app.retrieval import Retrieval
    from app.settings import Settings
    from app.sync.skills import SkillsSync

# (stage_name, payload) -> streamed to the client as a progress notification.
ProgressFn = Callable[[str, dict], Awaitable[None]]


@dataclass(frozen=True)
class CallMeta:
    """Who is calling: threaded into every audit event."""

    agent_session_id: str | None
    parent_agent_session_id: str | None
    subagent_class: str
    tool_call_id: str


@dataclass
class Deps:
    """One container wired at boot (app/server.py) and handed to every
    tool handler and hook gate — no globals, no re-reading env."""

    settings: Settings
    audit: AuditLog
    corpus: CorpusReader
    pipeline: Retrieval
    store: SessionStore
    chat: ChatClientProvider
    sync: SkillsSync
    plan_skills: PlanSkillCache
