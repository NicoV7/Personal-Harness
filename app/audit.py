"""Append-only JSONL audit log (CROSS-MODULE CONTRACT).

The audit log is BetterAI's only observability surface, so `record`
fails loud on IO errors instead of degrading to a warning — a silently
dropped event is a blackholed compliance trail. The parent directory is
created lazily on first record so merely constructing the log (e.g. in
tests or during boot wiring) never touches the filesystem.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from app.deps import CallMeta
from app.errors import Errors

AUDIT_FILE_MODE = 0o640


class AuditLog:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._dir_ready = False

    def record(self, event_type: str, payload: dict, meta: CallMeta | None = None) -> None:
        """Append one JSONL event line. One event per tool/hook call."""
        event = {
            "ts": datetime.now(UTC).isoformat(),
            "event_type": event_type,
            "payload": payload,
            "agent_session_id": meta.agent_session_id if meta else None,
            "parent_agent_session_id": meta.parent_agent_session_id if meta else None,
            "subagent_class": meta.subagent_class if meta else None,
            "tool_call_id": meta.tool_call_id if meta else None,
        }
        try:
            self._append_line(json.dumps(event, default=str))
        except OSError as exc:
            # No audit-specific factory exists in the frozen errors layer;
            # BAI-121 is the closest truthful code (the audit path is
            # configuration and this is its failure mode).
            raise Errors.config_invalid(
                "BETTERAI_AUDIT_PATH", f"audit append to {self._path} failed: {exc}"
            ) from exc

    def _append_line(self, line: str) -> None:
        self._ensure_dir()
        created = not self._path.exists()
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        if created:
            # open(...,"a") honors the umask; enforce the exact mode contract.
            os.chmod(self._path, AUDIT_FILE_MODE)

    def _ensure_dir(self) -> None:
        if self._dir_ready:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._dir_ready = True
