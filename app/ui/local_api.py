"""Host-side data for the `betterai ui` dashboard: audit tail, stats,
hook errors, doctor — everything the container cannot see or that would
be a wasteful round-trip through it.

Pure functions over paths (testable against tmp_path fixtures) plus the
Starlette routes that serve them under /api/local/*. Sync endpoints on
purpose: Starlette runs them in its threadpool, and doctor's health
probe is a blocking HTTP call.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.installer.install_env import betterai_root

# Newest slice of the audit file a request will scan; the file has no
# rotation yet, so reads are byte-capped instead of unbounded.
MAX_TAIL_BYTES = 8 * 1024 * 1024
DEFAULT_EXCLUDE = ("auth_bypass",)  # /health probe noise, ~90% of lines


def read_audit_events(
    audit_path: Path,
    *,
    limit: int = 200,
    offset: int = 0,
    event_type: str | None = None,
    session: str | None = None,
    exclude: tuple[str, ...] = DEFAULT_EXCLUDE,
) -> dict:
    """Newest-first filtered events plus the post-filter total."""
    events = []
    for line in reversed(_tail_lines(audit_path)):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event_type") in exclude:
            continue
        if event_type and event.get("event_type") != event_type:
            continue
        if session and event.get("agent_session_id") != session:
            continue
        events.append(event)
    return {"events": events[offset : offset + limit], "total": len(events)}


def read_hook_errors(log_path: Path, *, limit: int = 100) -> list[dict]:
    """Parsed tail of hook-errors.log: `<iso>Z <hook> curl_exit=<n>`."""
    if not log_path.exists():
        return []
    rows = []
    for line in reversed(log_path.read_text(encoding="utf-8").splitlines()[-limit * 2 :]):
        parts = line.split()
        if len(parts) != 3 or not parts[2].startswith("curl_exit="):
            continue
        rows.append({"ts": parts[0], "hook": parts[1], "curl_exit": parts[2].split("=", 1)[1]})
        if len(rows) >= limit:
            break
    return rows


def compute_stats(user_home: str, *, now: datetime | None = None) -> dict:
    """The dashboard stats strip. Local-only by decision: every number
    comes from files under ~/.betterai — nothing ever phones home.
    UI-originated audit events (subagent_class == "ui") are excluded so
    browsing the dashboard never inflates its own usage numbers."""
    root = Path(betterai_root(user_home))
    now = now or datetime.now(UTC)
    week_ago = now - timedelta(days=7)
    day_ago = now - timedelta(hours=24)

    prompts_7d = 0
    skill_reads_7d: Counter[str] = Counter()
    gate_denials_7d: Counter[str] = Counter()
    plan_serves_7d = 0
    plan_cache_hits_7d = 0
    for line in _tail_lines(root / "audit" / "audit.jsonl"):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("subagent_class") == "ui":
            continue
        ts = _parse_ts(event.get("ts"))
        if ts is None or ts < week_ago:
            continue
        kind = event.get("event_type")
        payload = event.get("payload") or {}
        if kind == "prompt_serve":
            prompts_7d += 1
        elif kind == "skill_read":
            skill_reads_7d[str(payload.get("id"))] += 1
        elif kind == "gate_denial":
            gate_denials_7d[str(payload.get("gate"))] += 1
        elif kind == "plan_serve":
            plan_serves_7d += 1
            plan_cache_hits_7d += 1 if payload.get("cache_hit") else 0

    hook_errors_24h = sum(
        1
        for row in read_hook_errors(root / "hook-errors.log", limit=10_000)
        if (ts := _parse_ts(row["ts"])) is not None and ts >= day_ago
    )
    return {
        "prompts_served_7d": prompts_7d,
        "skills_served_7d": sum(skill_reads_7d.values()),
        "top_skills_7d": [
            {"id": skill_id, "reads": count} for skill_id, count in skill_reads_7d.most_common(5)
        ],
        "gate_denials_7d": sum(gate_denials_7d.values()),
        "gate_denials_by_gate": dict(gate_denials_7d),
        "hook_errors_24h": hook_errors_24h,
        "corpus": {
            "rules": _count_markdown(root / "rules"),
            "skills": _count_markdown(root / "skills"),
        },
        "plan_cache": {"serves_7d": plan_serves_7d, "hits_7d": plan_cache_hits_7d},
    }


def local_routes(user_home: str) -> list:
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    root = Path(betterai_root(user_home))

    def doctor(request) -> JSONResponse:
        from app.doctor import failure_count, run_doctor

        checks = run_doctor(user_home)
        return JSONResponse(
            {"checks": [check.as_dict() for check in checks], "failures": failure_count(checks)}
        )

    def audit(request) -> JSONResponse:
        params = request.query_params
        exclude = DEFAULT_EXCLUDE if params.get("exclude", "auth_bypass") else ()
        return JSONResponse(
            read_audit_events(
                root / "audit" / "audit.jsonl",
                limit=min(int(params.get("limit", "200")), 1000),
                offset=int(params.get("offset", "0")),
                event_type=params.get("event_type") or None,
                session=params.get("session") or None,
                exclude=exclude,
            )
        )

    def stats(request) -> JSONResponse:
        return JSONResponse(compute_stats(user_home))

    def hook_errors(request) -> JSONResponse:
        limit = min(int(request.query_params.get("limit", "100")), 1000)
        return JSONResponse({"errors": read_hook_errors(root / "hook-errors.log", limit=limit)})

    return [
        Route("/api/local/doctor", doctor, methods=["GET"]),
        Route("/api/local/audit", audit, methods=["GET"]),
        Route("/api/local/stats", stats, methods=["GET"]),
        Route("/api/local/hook-errors", hook_errors, methods=["GET"]),
    ]


def _tail_lines(path: Path, max_bytes: int = MAX_TAIL_BYTES) -> list[str]:
    if not path.exists():
        return []
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > max_bytes:
            handle.seek(size - max_bytes)
            handle.readline()  # drop the partial first line
        return handle.read().decode("utf-8", errors="replace").splitlines()


def _parse_ts(raw: object) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _count_markdown(root: Path) -> int:
    if not root.is_dir():
        return 0
    return sum(1 for path in root.rglob("*.md") if "_meta" not in path.parts)
