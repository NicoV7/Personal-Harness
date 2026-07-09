"""Eval run orchestration: arms -> rubric -> blind judge -> report.

Runs host-side (CLI process, not the container): the judge model id and
OpenRouter base URL come from the install's `.env`, the key from the
install root, and the served corpus (for corpus-derived criteria) from
`~/.betterai/{rules,skills}` — the same tree the container mounts.
"""

from __future__ import annotations

import time
from pathlib import Path

from openai import OpenAI

from app.corpus.reader import CorpusReader
from app.errors import Errors
from app.evals.arms import ARM_CONTROL, ARM_TREATMENT, run_arm
from app.evals.judge import judge_fixture
from app.evals.report import fixture_report, run_report, write_report
from app.evals.rubric import compile_rubric, list_fixtures
from app.installer.install_env import betterai_root

BLOG_RUBRIC_FILENAME = "rubric-blogs.yaml"


def run_evals(
    *,
    user_home: str,
    fixtures_dir: Path,
    fixture_id: str | None,
) -> dict:
    fixtures = [
        fixture
        for fixture in list_fixtures(fixtures_dir / "fixtures")
        if fixture_id is None or fixture["id"] == fixture_id
    ]
    if not fixtures:
        raise Errors.artifact_invalid(str(fixtures_dir), f"no fixture named {fixture_id!r}")
    blog_rubric = fixtures_dir / BLOG_RUBRIC_FILENAME
    served = CorpusReader(betterai_root(user_home)).read()
    model, client = _judge_client(user_home)
    run_dir = Path(betterai_root(user_home)) / "eval" / "runs" / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    for fixture in fixtures:
        arms = [run_arm(fixture, arm, run_dir) for arm in (ARM_CONTROL, ARM_TREATMENT)]
        criteria = compile_rubric(fixture, blog_rubric, served)
        judged = judge_fixture(
            fixture,
            criteria,
            arms,
            model=model,
            client=client,
            judge_dir=run_dir / fixture["id"] / "judge",
        )
        reports.append(fixture_report(fixture, criteria, arms, judged))
    report = run_report(reports)
    report["report_path"] = str(write_report(run_dir, report))
    return report


def _judge_client(user_home: str) -> tuple[str, OpenAI]:
    root = Path(betterai_root(user_home))
    env = _read_env(root / ".env")
    model = env.get("BETTERAI_OPENROUTER_AGENT_MODEL")
    base_url = env.get("BETTERAI_OPENROUTER_BASE_URL")
    if not model or not base_url:
        raise Errors.config_missing(
            ["BETTERAI_OPENROUTER_AGENT_MODEL", "BETTERAI_OPENROUTER_BASE_URL"]
        )
    key_path = root / "openrouter-key"
    if not key_path.exists() or not key_path.read_text().strip():
        raise Errors.token_missing(str(key_path))
    return model, OpenAI(base_url=base_url, api_key=key_path.read_text().strip())


def _read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        raise Errors.config_invalid(str(path), "no install .env; run `betterai install`")
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values
