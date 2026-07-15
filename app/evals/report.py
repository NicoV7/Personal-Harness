"""Report math + rendering: weighted totals, min-score check, win rate."""

from __future__ import annotations

import json
from pathlib import Path

from app.evals.arms import ArmResult
from app.evals.judge import JudgeResult
from app.evals.rubric import Criterion

MAX_VERDICT = 2


def fixture_report(
    fixture: dict,
    criteria: list[Criterion],
    arms: list[ArmResult],
    judged: JudgeResult,
) -> dict:
    weighted = {
        arm: _weighted_score(criteria, judged.scores.get(arm, {})) for arm in judged.scores
    }
    expected_min = fixture.get("expected_rubric_min")
    treatment_raw = _raw_score(criteria, judged.scores.get("treatment", {}))
    return {
        "fixture": fixture["id"],
        "criteria": [
            {"id": c.id, "weight": c.weight, "source": c.source} for c in criteria
        ],
        "scores": judged.scores,
        "weighted": weighted,
        "winner": judged.winner,
        "rationale": judged.rationale,
        "mapping": judged.mapping,
        "arms": [
            {"arm": a.arm, "wall_seconds": a.wall_seconds, "exit_code": a.exit_code}
            for a in arms
        ],
        "expected_rubric_min": expected_min,
        "treatment_meets_min": (
            None if expected_min is None else treatment_raw >= int(expected_min)
        ),
    }


def run_report(fixture_reports: list[dict]) -> dict:
    wins = sum(1 for report in fixture_reports if report["winner"] == "treatment")
    ties = sum(1 for report in fixture_reports if report["winner"] == "tie")
    total = len(fixture_reports)
    return {
        "fixtures": fixture_reports,
        "total": total,
        "treatment_wins": wins,
        "ties": ties,
        "b_win_rate": round(wins / total, 3) if total else 0.0,
    }


def write_report(run_dir: Path, report: dict) -> Path:
    report_path = run_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2))
    (run_dir / "verdict.md").write_text(_verdict_markdown(report))
    return report_path


def _weighted_score(criteria: list[Criterion], verdicts: dict[str, int]) -> float:
    total_weight = sum(c.weight for c in criteria)
    if not total_weight:
        return 0.0
    earned = sum(c.weight * verdicts.get(c.id, 0) for c in criteria)
    return round(earned / (total_weight * MAX_VERDICT), 3)


def _raw_score(criteria: list[Criterion], verdicts: dict[str, int]) -> int:
    return sum(verdicts.get(c.id, 0) for c in criteria)


def _verdict_markdown(report: dict) -> str:
    lines = [
        "# BetterAI eval run",
        "",
        f"Treatment win rate: **{report['b_win_rate']}** "
        f"({report['treatment_wins']}/{report['total']}, ties: {report['ties']})",
        "",
        "| fixture | winner | control | treatment | meets min |",
        "|---|---|---|---|---|",
    ]
    for fixture in report["fixtures"]:
        weighted = fixture["weighted"]
        lines.append(
            f"| {fixture['fixture']} | {fixture['winner']} "
            f"| {weighted.get('control', '-')} | {weighted.get('treatment', '-')} "
            f"| {fixture['treatment_meets_min']} |"
        )
    return "\n".join(lines) + "\n"
