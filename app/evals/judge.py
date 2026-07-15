"""Blind LLM judge: score both arms' diffs per rubric criterion.

Blinding: the arm -> label (X/Y) mapping is randomized per fixture and
recorded to judge/mapping.json; every case-insensitive 'betterai' string
is redacted from the diffs so the judge cannot detect the treatment arm.
One structured call, one attempt, typed BAI-608 on malformed output.
"""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI, OpenAIError

from app.errors import Errors
from app.evals.arms import ArmResult
from app.evals.rubric import Criterion

VERDICTS = (0, 1, 2)
_MARKER = re.compile(r"betterai", re.IGNORECASE)
_DIFF_MAX_CHARS = 120_000

JUDGE_SYSTEM_PROMPT = """You are a rigorous, blind code reviewer. Two anonymous solutions \
(X and Y) implement the same task. Score EACH solution against EACH rubric criterion:
2 = met with concrete evidence in the diff, 1 = partially met, 0 = violated or absent.
Judge only what the diffs show; do not reward verbosity or comments. Reply with JSON only:

{"scores": {"X": {"<criterion-id>": 0|1|2, ...}, "Y": {...}},
 "winner": "X" | "Y" | "tie",
 "rationale": "one paragraph naming the decisive criteria"}"""


@dataclass(frozen=True)
class JudgeResult:
    scores: dict[str, dict[str, int]]  # arm name -> criterion id -> verdict
    winner: str  # "control" | "treatment" | "tie"
    rationale: str
    mapping: dict[str, str]  # label -> arm name


def judge_fixture(
    fixture: dict,
    criteria: list[Criterion],
    arms: list[ArmResult],
    *,
    model: str,
    client: OpenAI,
    judge_dir: Path,
) -> JudgeResult:
    mapping = _blind_mapping(arms)
    judge_dir.mkdir(parents=True, exist_ok=True)
    (judge_dir / "mapping.json").write_text(json.dumps(mapping, indent=2))
    prompt = _user_prompt(fixture, criteria, mapping, {a.arm: a for a in arms})
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:
        raise Errors.distill_failed(f"judge:{fixture['id']}", str(exc)) from exc
    result = _parse(fixture["id"], response.choices[0].message.content or "", mapping, criteria)
    (judge_dir / "verdict.json").write_text(
        json.dumps(
            {"scores": result.scores, "winner": result.winner, "rationale": result.rationale},
            indent=2,
        )
    )
    return result


def redact_markers(text: str) -> str:
    return _MARKER.sub("[redacted]", text)


def _blind_mapping(arms: list[ArmResult]) -> dict[str, str]:
    names = [arm.arm for arm in arms]
    if secrets.randbelow(2):
        names.reverse()
    return {"X": names[0], "Y": names[1]}


def _user_prompt(
    fixture: dict,
    criteria: list[Criterion],
    mapping: dict[str, str],
    by_arm: dict[str, ArmResult],
) -> str:
    rubric_lines = "\n".join(
        f"- {c.id} (weight {c.weight}): {c.criterion}" for c in criteria
    )
    id_listing = ", ".join(c.id for c in criteria)
    sections = [
        f"Task:\n{fixture['task_description']}",
        f"Rubric:\n{rubric_lines}",
        "Your scores object MUST contain an integer 0, 1, or 2 for EVERY one "
        f"of these criterion ids (no omissions, no nulls): {id_listing}",
    ]
    for label in ("X", "Y"):
        diff = Path(by_arm[mapping[label]].diff_path).read_text()[:_DIFF_MAX_CHARS]
        sections.append(f"Solution {label} diff:\n```diff\n{redact_markers(diff)}\n```")
    return "\n\n".join(sections)


def _parse(
    fixture_id: str, raw: str, mapping: dict[str, str], criteria: list[Criterion]
) -> JudgeResult:
    ref = f"judge:{fixture_id}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Errors.distill_failed(ref, f"non-JSON verdict: {exc}") from exc
    scores_by_label = payload.get("scores")
    winner_label = payload.get("winner")
    if not isinstance(scores_by_label, dict) or winner_label not in (*mapping, "tie"):
        raise Errors.distill_failed(ref, "verdict missing scores or a valid winner")
    scores: dict[str, dict[str, int]] = {}
    for label, arm in mapping.items():
        label_scores = scores_by_label.get(label)
        if not isinstance(label_scores, dict):
            raise Errors.distill_failed(ref, f"no scores for solution {label}")
        bad = [c.id for c in criteria if not _valid_verdict(label_scores.get(c.id))]
        if bad:
            raise Errors.distill_failed(
                ref,
                f"solution {label} verdict missing/invalid (must be 0|1|2) for "
                f"criteria: {', '.join(bad)}",
            )
        scores[arm] = {c.id: int(label_scores[c.id]) for c in criteria}
    winner = "tie" if winner_label == "tie" else mapping[winner_label]
    return JudgeResult(
        scores=scores,
        winner=winner,
        rationale=str(payload.get("rationale", "")),
        mapping=mapping,
    )


def _valid_verdict(value: object) -> bool:
    return isinstance(value, int) and value in VERDICTS
