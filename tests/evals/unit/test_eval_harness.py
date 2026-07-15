"""Eval harness units: rubric compiler, report math, judge blinding,
and the install-smoke dry run. No network, no LLM, no docker.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.corpus.schema import Artifact
from app.errors import DistillError
from app.evals.arms import ArmResult
from app.evals.judge import judge_fixture, redact_markers
from app.evals.report import fixture_report, run_report
from app.evals.rubric import Criterion, compile_rubric
from app.evals.smoke import run_install_smoke

FIXTURE = {
    "id": "backend-http-client",
    "task_description": "Add an HTTP client.",
    "rubric": [
        {"id": "no-retry-loop", "weight": 3, "criterion": "One attempt per call."},
        # Same id as a blog criterion: fixture wording must win the dedupe.
        {"id": "no-retries", "weight": 3, "criterion": "Fixture-specific no-retries."},
    ],
    "expected_rubric_min": 4,
}

BLOG_RUBRIC = """
criteria:
  - id: no-retries
    source: A
    weight: 3
    criterion: Blog-generic no-retries.
  - id: secrets-hygiene
    source: B
    weight: 3
    criterion: No secrets in source or logs.
"""

FORCED_RULE = Artifact(
    id="no-env-defaults",
    artifact_type="rule",
    title="Do not set defaults for environment variables",
    category="backend-code",
    forced=True,
    body="## What this rule says\n\nWrite better Dockerfiles instead.\n\n## Why it matters\n\nX.",
)


def _arm(tmp_path: Path, arm: str, diff: str) -> ArmResult:
    diff_path = tmp_path / f"{arm}.patch"
    diff_path.write_text(diff)
    return ArmResult(
        arm=arm,
        workdir=str(tmp_path),
        diff_path=str(diff_path),
        transcript_path=str(tmp_path / f"{arm}.json"),
        wall_seconds=1.0,
        exit_code=0,
    )


class FakeJudgeClient:
    def __init__(self, payload_fn) -> None:
        self.last_prompt: str | None = None

        def create(**kwargs):
            self.last_prompt = kwargs["messages"][1]["content"]
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=payload_fn()))]
            )

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


class TestRubricCompiler:
    def test_merges_fixture_blog_and_forced_corpus_criteria(self, tmp_path):
        # arrange
        blog_path = tmp_path / "rubric-blogs.yaml"
        blog_path.write_text(BLOG_RUBRIC)

        # act
        criteria = compile_rubric(FIXTURE, blog_path, [FORCED_RULE])

        # assert
        by_id = {criterion.id: criterion for criterion in criteria}
        assert by_id["no-retries"].source == "fixture"  # fixture wins the dedupe
        assert by_id["secrets-hygiene"].source == "blogs:B"
        assert "corpus-no-env-defaults" in by_id
        assert "Dockerfiles" in by_id["corpus-no-env-defaults"].criterion

    def test_unforced_artifacts_do_not_become_criteria(self, tmp_path):
        blog_path = tmp_path / "rubric-blogs.yaml"
        blog_path.write_text(BLOG_RUBRIC)
        unforced = FORCED_RULE.model_copy(update={"forced": False})
        criteria = compile_rubric(FIXTURE, blog_path, [unforced])
        assert not [c for c in criteria if c.source == "corpus"]


class TestJudge:
    CRITERIA = [Criterion("no-retry-loop", 3, "One attempt.", "fixture")]

    def _judge(self, tmp_path, payload_fn):
        arms = [
            _arm(tmp_path, "control", "diff with retry loop"),
            _arm(tmp_path, "treatment", "clean diff via BetterAI hooks"),
        ]
        client = FakeJudgeClient(payload_fn)
        result = judge_fixture(
            FIXTURE,
            self.CRITERIA,
            arms,
            model="test/judge",
            client=client,
            judge_dir=tmp_path / "judge",
        )
        return result, client

    def test_scores_map_back_through_the_recorded_blind_mapping(self, tmp_path):
        # arrange: winner is always label X, whatever arm X is
        payload = lambda: json.dumps(
            {"scores": {"X": {"no-retry-loop": 2}, "Y": {"no-retry-loop": 0}}, "winner": "X"}
        )

        # act
        result, _ = self._judge(tmp_path, payload)

        # assert
        mapping = json.loads((tmp_path / "judge" / "mapping.json").read_text())
        assert result.mapping == mapping
        winner_arm = mapping["X"]
        assert result.winner == winner_arm
        assert result.scores[winner_arm]["no-retry-loop"] == 2

    def test_betterai_markers_are_redacted_from_judge_prompt(self, tmp_path):
        payload = lambda: json.dumps(
            {"scores": {"X": {"no-retry-loop": 1}, "Y": {"no-retry-loop": 1}}, "winner": "tie"}
        )
        _, client = self._judge(tmp_path, payload)
        assert "BetterAI" not in client.last_prompt
        assert "[redacted]" in client.last_prompt

    def test_malformed_verdict_fails_loud(self, tmp_path):
        with pytest.raises(DistillError):
            self._judge(tmp_path, lambda: json.dumps({"winner": "X"}))

    def test_redact_markers_is_case_insensitive(self):
        assert redact_markers("betterai BETTERAI BetterAI") == "[redacted] [redacted] [redacted]"


class TestReportMath:
    CRITERIA = [
        Criterion("a", 3, "A.", "fixture"),
        Criterion("b", 1, "B.", "blogs:A"),
    ]

    def test_weighted_totals_and_min_check(self, tmp_path):
        # arrange
        judged = SimpleNamespace(
            scores={"control": {"a": 0, "b": 2}, "treatment": {"a": 2, "b": 2}},
            winner="treatment",
            rationale="treatment avoided retries",
            mapping={"X": "control", "Y": "treatment"},
        )
        arms = [_arm(tmp_path, "control", ""), _arm(tmp_path, "treatment", "")]

        # act
        report = fixture_report(FIXTURE, self.CRITERIA, arms, judged)

        # assert: control = (3*0 + 1*2)/8, treatment = (3*2 + 1*2)/8
        assert report["weighted"] == {"control": 0.25, "treatment": 1.0}
        assert report["treatment_meets_min"] is True  # raw 4 >= expected_rubric_min 4

    def test_win_rate_over_fixtures(self):
        reports = [
            {"winner": "treatment"},
            {"winner": "control"},
            {"winner": "treatment"},
            {"winner": "tie"},
        ]
        summary = run_report(reports)
        assert summary["treatment_wins"] == 2
        assert summary["ties"] == 1
        assert summary["b_win_rate"] == 0.5


class TestInstallSmokeDryRun:
    def test_dry_run_passes_with_all_checks(self):
        # act
        result = run_install_smoke(dry_run=True, user_home="/nonexistent-not-used")

        # assert
        failed = [check for check in result["checks"] if not check["ok"]]
        assert result["dry_run"] is True
        assert failed == []
        names = {check["name"] for check in result["checks"]}
        assert "claude auto-allowed skill reads" in names
        assert "no secret values in client configs" in names
