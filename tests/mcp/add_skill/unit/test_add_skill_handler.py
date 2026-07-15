"""add_skill: parse/classify/write/index pipeline, progress order, fail-loud."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.errors import ArtifactInvalidError, Errors, IndexWriteError
from app.mcp.add_skill import handler
from app.mcp.add_skill.schema import INPUT_MODEL

COMPLETE_SKILL_MD = """---
id: prefer-composition
artifact_type: skill
title: Prefer composition for shared behavior
category: refactoring
domain: maintainability
when_to_use: When two classes share behavior.
applies_when:
  intents:
    - composition
    - shared behavior
related:
  - reduce-nesting-with-composition
---

## When to use this skill

When behavior is duplicated.

## Steps

1. Extract the shared behavior into a component.
"""

BARE_RULE_MD = """---
title: Never discard errors into the blank identifier
---

{body}
"""


class RecordingProgress:
    def __init__(self) -> None:
        self.stages: list[str] = []

    async def __call__(self, stage: str, payload: dict) -> None:
        self.stages.append(stage)


class _ForbiddenChat:
    def get(self):
        raise AssertionError("complete frontmatter must never construct the chat client")


class _StubChat:
    def get(self):
        return object()


def _forbid_llm(deps):
    deps.chat = _ForbiddenChat()


class TestCompleteFrontmatter:
    async def test_writes_indexes_and_reports_progress_in_order(
        self, deps, meta, pipeline, monkeypatch
    ):
        # arrange
        _forbid_llm(deps)
        progress = RecordingProgress()
        # act
        out = await handle_md(deps, meta, COMPLETE_SKILL_MD, on_progress=progress)
        # assert
        path = Path(out["path"])
        assert path == Path(deps.corpus.global_root) / "skills" / "refactoring" / "prefer-composition.md"
        assert out == {
            "id": "prefer-composition",
            "path": str(path),
            "classified": [],
            "indexed": True,
        }
        assert progress.stages == ["parsed", "classified", "indexed"]
        assert [a.id for a in pipeline.indexed] == ["prefer-composition"]
        # unmodeled frontmatter keys survive the round-trip
        assert "related:" in path.read_text()
        reread = deps.corpus.find("prefer-composition")
        assert reread is not None and reread.artifact_type == "skill"

    async def test_forced_override_lands_in_file(self, deps, meta, monkeypatch):
        # arrange
        _forbid_llm(deps)
        # act
        await handle_md(deps, meta, COMPLETE_SKILL_MD, forced=True)
        # assert
        assert deps.corpus.find("prefer-composition").forced is True

    async def test_audit_event_written(self, deps, meta, read_audit, monkeypatch):
        # arrange
        _forbid_llm(deps)
        # act
        await handle_md(deps, meta, COMPLETE_SKILL_MD)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "skill_added"
        assert event["payload"]["id"] == "prefer-composition"
        assert event["payload"]["classified"] == []


class TestClassification:
    async def test_missing_facets_filled_by_classifier(
        self, deps, meta, rule_body, monkeypatch
    ):
        # arrange
        deps.chat = _StubChat()
        requested: dict = {}

        def fake_classify(frontmatter, body, missing, settings, client):
            requested["missing"] = list(missing)
            return {
                "id": "no-bare-blank-discard",
                "artifact_type": "rule",
                "category": "STANDARDS",
                "domain": "maintainability",
                "severity": "medium",
                "when_to_use": "When a Go multi-return tempts a bare _.",
                "applies_when": {"intents": ["naming", "blank identifier"]},
            }

        monkeypatch.setattr(handler, "classify_missing", fake_classify)
        markdown = BARE_RULE_MD.format(body=rule_body)
        # act
        out = await handle_md(deps, meta, markdown)
        # assert
        assert set(requested["missing"]) == {
            "id", "artifact_type", "category", "domain", "when_to_use", "intents",
        }
        assert out["id"] == "no-bare-blank-discard"
        assert sorted(out["classified"]) == sorted(requested["missing"])
        reread = deps.corpus.find("no-bare-blank-discard")
        assert reread.applies_when.intents == ["naming", "blank identifier"]
        assert reread.severity == "medium"


class TestFailLoud:
    async def test_markdown_without_frontmatter_rejected(self, deps, meta):
        with pytest.raises(ArtifactInvalidError):
            await handle_md(deps, meta, "just prose, no frontmatter block")

    async def test_rule_missing_sections_rejected_listing_gaps(
        self, deps, meta, monkeypatch
    ):
        # arrange
        _forbid_llm(deps)
        markdown = COMPLETE_SKILL_MD.replace("artifact_type: skill", "artifact_type: rule").replace(
            "id: prefer-composition", "id: some-rule"
        )
        markdown = markdown.replace("category: refactoring", "category: STANDARDS\nseverity: low")
        # act / assert
        with pytest.raises(ArtifactInvalidError) as excinfo:
            await handle_md(deps, meta, markdown)
        assert "## Why it matters" in str(excinfo.value)

    async def test_index_failure_propagates_but_file_survives(
        self, deps, meta, pipeline, monkeypatch
    ):
        # arrange
        _forbid_llm(deps)
        pipeline.index_error = Errors.index_write_error("redis down")
        # act
        with pytest.raises(IndexWriteError) as excinfo:
            await handle_md(deps, meta, COMPLETE_SKILL_MD)
        # assert
        assert "betterai index" in str(excinfo.value)
        path = Path(deps.corpus.global_root) / "skills" / "refactoring" / "prefer-composition.md"
        assert path.exists()


async def handle_md(deps, meta, markdown: str, *, forced: bool | None = None, on_progress=None):
    payload = INPUT_MODEL(markdown=markdown) if forced is None else INPUT_MODEL(
        markdown=markdown, forced=forced
    )
    return await handler.handle(payload, deps, meta, on_progress=on_progress)
