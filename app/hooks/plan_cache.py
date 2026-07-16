"""Plan-scoped skill cache + session→plan mapping (plan-mode retrieval).

Retrieval runs once per plan write (app/hooks/routes.py) and lands here,
keyed by NORMALIZED PLAN PATH — not session id — because subagents call
the MCP tools under their own session ids while the server is one shared
process. The session→plan mapping rides the SessionStore in a
session-lifetime namespace (deliberately NOT in registry TURN_NAMESPACES,
same reasoning as plan_manifest: the plan governs the whole task, not one
prompt). Restart or LRU eviction loses entries and every consumer falls
back — the prompt hook to fresh retrieval, get_plan_skills to corpus
reads off the plan's Skill Audit ids.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.corpus.schema import Artifact
from app.hooks.state import SessionStore
from app.mcp.plan_manifest_gate.store import normalize_path

# Implementation bound, not behavior config (mirrors state.MAX_SESSIONS).
MAX_PLANS = 64

NAMESPACE = "plan_skills"
ACTIVE_PLAN_KEY = "active_plan"
SKILL_AUDIT_HEADING = "## Skill Audit"


@dataclass(frozen=True)
class PlanSkillMatch:
    """One skill matched to a plan: provenance says WHY (the plan section
    whose query won), served_at says when it was first cached."""

    artifact: Artifact
    score: float
    provenance: str
    served_at: str


@dataclass
class PlanCacheEntry:
    plan_path: str
    content_hash: str
    matches: dict[str, PlanSkillMatch] = field(default_factory=dict)
    updated_at: str = ""


class PlanSkillCache:
    """LRU-bounded plan-path→entry map; insertion order = recency order
    (the InMemorySessionStore._touch idiom)."""

    def __init__(self, max_plans: int = MAX_PLANS) -> None:
        self._max_plans = max_plans
        self._entries: dict[str, PlanCacheEntry] = {}

    def get(self, plan_path: str) -> PlanCacheEntry | None:
        return self._entries.get(normalize_path(plan_path))

    def latest(self) -> PlanCacheEntry | None:
        if not self._entries:
            return None
        return self._entries[next(reversed(self._entries))]

    def upsert(
        self,
        plan_path: str,
        content_hash: str,
        matches: list[PlanSkillMatch],
    ) -> list[PlanSkillMatch]:
        """Merge matches into the plan's entry and return only the matches
        whose skill id is NEW to this plan — the dedupe seam that keeps
        repeated plan writes from re-serving identical bodies. Existing
        matches keep their original provenance and served_at."""
        path = normalize_path(plan_path)
        entry = self._entries.pop(path, None) or PlanCacheEntry(
            plan_path=path, content_hash=content_hash
        )
        entry.content_hash = content_hash
        entry.updated_at = now_iso()
        new_matches = [m for m in matches if m.artifact.id not in entry.matches]
        for match in new_matches:
            entry.matches[match.artifact.id] = match
        self._entries[path] = entry
        while len(self._entries) > self._max_plans:
            self._entries.pop(next(iter(self._entries)))
        return new_matches


def set_active_plan(store: SessionStore, session_id: str | None, plan_path: str) -> None:
    if not session_id:
        return
    store.set(session_id, NAMESPACE, ACTIVE_PLAN_KEY, normalize_path(plan_path))


def active_plan(store: SessionStore, session_id: str | None) -> str | None:
    if not session_id:
        return None
    value = store.get(session_id, NAMESPACE, ACTIVE_PLAN_KEY)
    return value if isinstance(value, str) else None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def strip_skill_audit(markdown: str) -> str:
    """Drop the '## Skill Audit' section: the audit write-back must never
    feed the next retrieval (hook feedback loop) or change the plan hash."""
    kept: list[str] = []
    skipping = False
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("## ") or stripped.startswith("# "):
            skipping = stripped == SKILL_AUDIT_HEADING
        if not skipping:
            kept.append(line)
    return "\n".join(kept)


def plan_sections(markdown: str) -> list[tuple[str, str]]:
    """(heading, body) per '## ' section; text before the first heading
    (title, intro) lands as ('', preamble)."""
    sections: list[tuple[str, str]] = []
    heading = ""
    body: list[str] = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            _flush(sections, heading, body)
            heading = stripped[3:].strip()
            body = []
        else:
            body.append(line)
    _flush(sections, heading, body)
    return sections


def plan_content_hash(markdown: str) -> str:
    # Leading/trailing whitespace is immaterial: stripping a trailing
    # section must not change the hash of what remains.
    return hashlib.sha256(markdown.strip().encode("utf-8")).hexdigest()


def _flush(sections: list[tuple[str, str]], heading: str, body: list[str]) -> None:
    text = "\n".join(body).strip()
    if heading or text:
        sections.append((heading, text))
