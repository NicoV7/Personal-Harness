"""Rubric compiler: fixture criteria + blog-derived criteria + criteria
minted from the forced corpus rules actually served. Deduped by id with
fixture criteria winning (they are the most task-specific).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from app.errors import Errors

CORPUS_CRITERION_WEIGHT = 2
_EXCERPT_SECTION = "## What this rule says"
_EXCERPT_MAX_CHARS = 300


@dataclass(frozen=True)
class Criterion:
    id: str
    weight: int
    criterion: str
    source: str  # "fixture" | "blogs:<A|B>" | "corpus"


def load_fixture(path: Path) -> dict:
    fixture = _load_yaml(path)
    for key in ("id", "task_description", "rubric"):
        if not fixture.get(key):
            raise Errors.artifact_invalid(str(path), f"fixture is missing '{key}'")
    return fixture


def list_fixtures(fixtures_dir: Path) -> list[dict]:
    paths = sorted(fixtures_dir.glob("*.yaml"))
    if not paths:
        raise Errors.artifact_invalid(str(fixtures_dir), "no fixture .yaml files found")
    return [load_fixture(path) for path in paths]


def compile_rubric(
    fixture: dict, blog_rubric_path: Path, served_artifacts: list = ()
) -> list[Criterion]:
    criteria = [
        Criterion(row["id"], int(row.get("weight", 1)), row["criterion"].strip(), "fixture")
        for row in fixture["rubric"]
    ]
    blog = _load_yaml(blog_rubric_path)
    criteria += [
        Criterion(
            row["id"],
            int(row.get("weight", 1)),
            row["criterion"].strip(),
            f"blogs:{row.get('source', '?')}",
        )
        for row in blog.get("criteria", [])
    ]
    criteria += [
        Criterion(
            f"corpus-{artifact.id}",
            CORPUS_CRITERION_WEIGHT,
            f"{artifact.title}: {_rule_excerpt(artifact.body)}",
            "corpus",
        )
        for artifact in served_artifacts
        if getattr(artifact, "forced", False) and getattr(artifact, "artifact_type", "") == "rule"
    ]
    deduped: dict[str, Criterion] = {}
    for criterion in criteria:
        deduped.setdefault(criterion.id, criterion)
    return list(deduped.values())


def _rule_excerpt(body: str) -> str:
    lines = body.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == _EXCERPT_SECTION)
    except StopIteration:
        return body.strip()[:_EXCERPT_MAX_CHARS]
    excerpt: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        excerpt.append(line)
    return " ".join(" ".join(excerpt).split())[:_EXCERPT_MAX_CHARS]


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        raise Errors.artifact_invalid(str(path), "file does not exist")
    loaded = yaml.safe_load(path.read_text())
    if not isinstance(loaded, dict):
        raise Errors.artifact_invalid(str(path), "expected a YAML mapping")
    return loaded
