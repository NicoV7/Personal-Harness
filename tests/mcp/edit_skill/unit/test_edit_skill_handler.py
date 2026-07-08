"""edit_skill: section validation, write-then-reindex order, fail-loud reindex."""

from __future__ import annotations

import stat
from pathlib import Path

import pytest

from app.corpus.reader import CorpusReader
from app.errors import ArtifactInvalidError, Errors, IndexWriteError
from app.mcp.edit_skill.handler import handle
from app.mcp.edit_skill.schema import INPUT_MODEL

VALID_RULE_BODY = (
    "## What this rule says\n\nx\n\n## Why it matters\n\nx\n\n"
    "## When this applies\n\nx\n\n## What good looks like\n\nx\n\n"
    "## Anti-patterns\n\nx\n"
)


def _rule_input(body: str = VALID_RULE_BODY, scope: str = "global"):
    return INPUT_MODEL(
        artifact={
            "id": "config-explicit-no-defaults",
            "artifact_type": "rule",
            "category": "STANDARDS",
            "title": "Config is explicit",
            "severity": "high",
            "domain": "maintainability",
            "body": body,
        },
        scope=scope,
    )


class TestValidation:
    async def test_rule_missing_sections_rejected_listing_each(self, deps, meta):
        # arrange
        payload = _rule_input(body="## What this rule says\n\nonly one section\n")
        # act
        with pytest.raises(ArtifactInvalidError) as excinfo:
            await handle(payload, deps, meta)
        # assert
        message = str(excinfo.value)
        for section in (
            "## Why it matters",
            "## When this applies",
            "## What good looks like",
            "## Anti-patterns",
        ):
            assert section in message
        target = Path(deps.corpus.global_root) / "rules" / "STANDARDS"
        assert not (target / "config-explicit-no-defaults.md").exists()

    async def test_repo_scope_without_repo_root_rejected(self, deps, meta, corpus_root):
        # arrange
        deps.corpus = CorpusReader(str(corpus_root))
        # act / assert
        with pytest.raises(ArtifactInvalidError):
            await handle(_rule_input(scope="repo"), deps, meta)


class TestWriteThrough:
    async def test_writes_markdown_readable_by_corpus_reader(self, deps, meta):
        # arrange
        payload = _rule_input()
        # act
        out = await handle(payload, deps, meta)
        # assert (roundtrip: the written file parses back to the same artifact)
        path = Path(out["path"])
        assert path == Path(deps.corpus.global_root) / "rules" / "STANDARDS" / "config-explicit-no-defaults.md"
        assert stat.S_IMODE(path.stat().st_mode) == 0o640
        reread = deps.corpus.find("config-explicit-no-defaults")
        assert reread is not None
        assert reread.artifact_type == "rule"
        assert reread.severity == "high"
        assert out["indexed"] is True

    async def test_file_exists_before_reindex_is_called(self, deps, meta, pipeline):
        # arrange
        payload = _rule_input()
        # act
        await handle(payload, deps, meta)
        # assert (write-through order: disk first, then index)
        assert pipeline.files_present_at_index == [True]
        assert [a.id for a in pipeline.indexed] == ["config-explicit-no-defaults"]

    async def test_reindex_failure_propagates_but_file_survives(
        self, deps, meta, pipeline
    ):
        # arrange
        pipeline.index_error = Errors.index_write_error("redis down")
        payload = _rule_input()
        # act
        with pytest.raises(IndexWriteError) as excinfo:
            await handle(payload, deps, meta)
        # assert
        assert "betterai index" in str(excinfo.value)
        path = (
            Path(deps.corpus.global_root)
            / "rules"
            / "STANDARDS"
            / "config-explicit-no-defaults.md"
        )
        assert path.exists()

    async def test_skill_kind_writes_under_skills_and_needs_no_sections(
        self, deps, meta
    ):
        # arrange
        payload = INPUT_MODEL(
            artifact={
                "id": "edit-incrementally",
                "artifact_type": "skill",
                "category": "editing",
                "title": "Edit incrementally",
                "forced": True,
                "when_to_use": "When granularity is active",
                "applies_when": {"intents": ["edit", "refactor"]},
                "body": "## Steps\n\n1. One function per turn.\n",
            },
            scope="repo",
        )
        # act
        out = await handle(payload, deps, meta)
        # assert
        path = Path(out["path"])
        assert path == Path(deps.corpus.repo_root) / "skills" / "editing" / "edit-incrementally.md"
        reread = deps.corpus.find("edit-incrementally")
        assert reread.forced is True
        assert reread.scope == "repo"
        assert reread.applies_when.intents == ["edit", "refactor"]

    async def test_audit_skill_edited_event_written(self, deps, meta, read_audit):
        # arrange
        payload = _rule_input()
        # act
        out = await handle(payload, deps, meta)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "skill_edited"
        assert event["payload"] == {
            "id": "config-explicit-no-defaults",
            "path": out["path"],
            "scope": "global",
            "indexed": True,
        }
        assert event["tool_call_id"] == "call-1"
