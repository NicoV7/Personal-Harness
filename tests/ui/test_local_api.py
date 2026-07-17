"""Host-side local API: audit tail filtering, stats math, hook errors.

Fixtures are synthetic files under tmp_path shaped exactly like the live
~/.betterai tree; no live host paths, no network.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.ui.local_api import (
    compute_stats,
    read_audit_events,
    read_hook_errors,
    _tail_lines,
)

NOW = datetime(2026, 7, 16, 12, 0, 0, tzinfo=UTC)


def _event(ts: datetime, event_type: str, payload: dict, *, session="s-1", subagent="main") -> str:
    return json.dumps(
        {
            "ts": ts.isoformat(),
            "event_type": event_type,
            "payload": payload,
            "agent_session_id": session,
            "parent_agent_session_id": None,
            "subagent_class": subagent,
            "tool_call_id": "tc-1",
        }
    )


def _home(tmp_path: Path) -> Path:
    root = tmp_path / ".betterai"
    (root / "audit").mkdir(parents=True)
    (root / "rules" / "cat").mkdir(parents=True)
    (root / "skills" / "cat").mkdir(parents=True)
    (root / "rules" / "cat" / "r1.md").write_text("x")
    (root / "rules" / "_meta" / "sub").mkdir(parents=True)
    (root / "rules" / "_meta" / "sub" / "schema.md").write_text("x")  # must not count
    (root / "skills" / "cat" / "s1.md").write_text("x")
    (root / "skills" / "cat" / "s2.md").write_text("x")
    return root


def _write_audit(root: Path, lines: list[str]) -> Path:
    path = root / "audit" / "audit.jsonl"
    path.write_text("\n".join(lines) + "\n")
    return path


def test_read_audit_events_newest_first_with_default_exclude(tmp_path):
    # arrange
    root = _home(tmp_path)
    path = _write_audit(
        root,
        [
            _event(NOW - timedelta(minutes=3), "auth_bypass", {}),
            _event(NOW - timedelta(minutes=2), "retrieve", {"intent": "a"}),
            "not json at all",
            _event(NOW - timedelta(minutes=1), "skill_read", {"id": "x"}),
        ],
    )

    # act
    result = read_audit_events(path)

    # assert: auth_bypass and the corrupt line are dropped, newest first
    assert [event["event_type"] for event in result["events"]] == ["skill_read", "retrieve"]
    assert result["total"] == 2


def test_read_audit_events_filters_and_paginates(tmp_path):
    # arrange
    root = _home(tmp_path)
    lines = [
        _event(NOW - timedelta(minutes=i), "skill_read", {"id": f"skill-{i}"}, session=f"s-{i % 2}")
        for i in range(10)
    ]
    path = _write_audit(root, lines)

    # act
    by_session = read_audit_events(path, session="s-1")
    paged = read_audit_events(path, limit=3, offset=3)
    by_type = read_audit_events(path, event_type="prompt_serve")

    # assert
    assert {event["agent_session_id"] for event in by_session["events"]} == {"s-1"}
    assert len(paged["events"]) == 3 and paged["total"] == 10
    assert by_type["events"] == [] and by_type["total"] == 0


def test_tail_lines_caps_bytes_and_drops_partial_line(tmp_path):
    # arrange
    path = tmp_path / "audit.jsonl"
    path.write_text("".join(f"line-{i:04d}\n" for i in range(100)))

    # act
    lines = _tail_lines(path, max_bytes=250)

    # assert: capped read, first (possibly partial) line dropped, tail intact
    assert lines[-1] == "line-0099"
    assert 0 < len(lines) < 100
    assert all(line.startswith("line-") and len(line) == 9 for line in lines)


def test_read_hook_errors_parses_and_limits(tmp_path):
    # arrange
    log = tmp_path / "hook-errors.log"
    log.write_text(
        "2026-07-15T12:00:00Z stop curl_exit=28\n"
        "garbage line\n"
        "2026-07-15T12:01:00Z user-prompt-submit curl_exit=7\n"
    )

    # act
    rows = read_hook_errors(log, limit=1)

    # assert: newest first, malformed skipped, limit honored
    assert rows == [{"ts": "2026-07-15T12:01:00Z", "hook": "user-prompt-submit", "curl_exit": "7"}]


def test_compute_stats_windows_and_ui_exclusion(tmp_path):
    # arrange
    root = _home(tmp_path)
    _write_audit(
        root,
        [
            _event(NOW - timedelta(days=1), "prompt_serve", {"served": 2}),
            _event(NOW - timedelta(days=8), "prompt_serve", {"served": 2}),  # outside 7d
            _event(NOW - timedelta(days=2), "skill_read", {"id": "top-skill"}),
            _event(NOW - timedelta(days=2), "skill_read", {"id": "top-skill"}),
            _event(NOW - timedelta(days=3), "skill_read", {"id": "other"}),
            _event(NOW - timedelta(days=1), "skill_read", {"id": "ui-noise"}, subagent="ui"),
            _event(NOW - timedelta(days=1), "gate_denial", {"gate": "read_gate"}),
            _event(NOW - timedelta(days=1), "plan_serve", {"cache_hit": True}),
            _event(NOW - timedelta(days=1), "plan_serve", {"cache_hit": False}),
        ],
    )
    (root / "hook-errors.log").write_text(
        f"{(NOW - timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')} stop curl_exit=28\n"
        f"{(NOW - timedelta(hours=30)).strftime('%Y-%m-%dT%H:%M:%SZ')} stop curl_exit=28\n"
    )

    # act
    stats = compute_stats(str(tmp_path), now=NOW)

    # assert
    assert stats["prompts_served_7d"] == 1
    assert stats["skills_served_7d"] == 3  # ui-originated read excluded
    assert stats["top_skills_7d"][0] == {"id": "top-skill", "reads": 2}
    assert stats["gate_denials_7d"] == 1
    assert stats["gate_denials_by_gate"] == {"read_gate": 1}
    assert stats["hook_errors_24h"] == 1
    assert stats["corpus"] == {"rules": 1, "skills": 2}  # _meta tree not counted
    assert stats["plan_cache"] == {"serves_7d": 2, "hits_7d": 1}
