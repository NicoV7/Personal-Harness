"""configure_skill: schema-validated updates, raw-frontmatter preservation."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from app.errors import ArtifactInvalidError, ArtifactNotFoundError, Errors, IndexWriteError
from app.mcp.configure_skill.handler import handle
from app.mcp.configure_skill.schema import INPUT_MODEL

CONFIGURABLE_FRONTMATTER = """
id: concise-comments
title: Comments explain WHY
category: STANDARDS
severity: medium
domain: maintainability
forced: true
check:
  artifact_type: regex
  pattern: "TODO"
settings_schema:
  level:
    type: string
    pattern: "^(default|none|tokens:[1-9][0-9]*|lines:[1-9][0-9]*)$"
    description: Comment verbosity level.
    default: default
settings:
  level: default
"""


@pytest.fixture
def configurable_path(corpus_root, write_markdown, rule_body) -> Path:
    return write_markdown(
        corpus_root / "rules" / "STANDARDS" / "concise-comments.md",
        CONFIGURABLE_FRONTMATTER,
        rule_body,
    )


def _payload(**settings: str):
    return INPUT_MODEL(skill_id="concise-comments", settings=settings)


class TestValidation:
    async def test_unknown_key_rejected(self, deps, meta, configurable_path):
        with pytest.raises(ArtifactInvalidError) as excinfo:
            await handle(_payload(volume="high"), deps, meta)
        assert "unknown setting" in str(excinfo.value)

    async def test_value_violating_pattern_rejected(self, deps, meta, configurable_path):
        with pytest.raises(ArtifactInvalidError) as excinfo:
            await handle(_payload(level="lines:zero"), deps, meta)
        assert "must match" in str(excinfo.value)

    async def test_artifact_without_schema_rejected(self, deps, meta):
        with pytest.raises(ArtifactInvalidError) as excinfo:
            await handle(
                INPUT_MODEL(skill_id="fail-loud-no-retries", settings={"level": "none"}),
                deps,
                meta,
            )
        assert "no settings_schema" in str(excinfo.value)

    async def test_unknown_artifact_raises_not_found(self, deps, meta):
        with pytest.raises(ArtifactNotFoundError):
            await handle(INPUT_MODEL(skill_id="no-such-skill", settings={"a": "b"}), deps, meta)

    async def test_empty_settings_rejected(self, deps, meta, configurable_path):
        with pytest.raises(ArtifactInvalidError):
            await handle(INPUT_MODEL(skill_id="concise-comments", settings={}), deps, meta)


class TestWriteThrough:
    async def test_updates_setting_and_preserves_unmodeled_keys(
        self, deps, meta, pipeline, configurable_path
    ):
        # act
        out = await handle(_payload(level="lines:2"), deps, meta)
        # assert
        assert out == {
            "id": "concise-comments",
            "settings": {"level": "lines:2"},
            "indexed": True,
        }
        frontmatter = yaml.safe_load(
            configurable_path.read_text().split("---")[1]
        )
        assert frontmatter["settings"] == {"level": "lines:2"}
        assert frontmatter["check"] == {"artifact_type": "regex", "pattern": "TODO"}
        assert frontmatter["forced"] is True
        assert [a.id for a in pipeline.indexed] == ["concise-comments"]
        reread = deps.corpus.find("concise-comments")
        assert reread.settings == {"level": "lines:2"}

    async def test_index_failure_propagates_but_update_survives(
        self, deps, meta, pipeline, configurable_path
    ):
        # arrange
        pipeline.index_error = Errors.index_write_error("redis down")
        # act
        with pytest.raises(IndexWriteError) as excinfo:
            await handle(_payload(level="none"), deps, meta)
        # assert
        assert "betterai index" in str(excinfo.value)
        assert "level: none" in configurable_path.read_text()

    async def test_audit_event_records_keys(self, deps, meta, read_audit, configurable_path):
        # act
        await handle(_payload(level="tokens:150"), deps, meta)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "skill_configured"
        assert event["payload"] == {
            "id": "concise-comments",
            "keys": ["level"],
            "settings": {"level": "tokens:150"},
        }
