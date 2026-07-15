"""Corpus writer: render -> write -> CorpusReader round-trip equality,
provenance survival, and required-rule-section rejection.
"""

from __future__ import annotations

import pytest

from app.corpus.reader import CorpusReader
from app.corpus.schema import REQUIRED_RULE_SECTIONS
from app.corpus.writer import (
    AppliesWhenInput,
    ArtifactInput,
    artifact_path,
    check_rule_sections,
    render_markdown,
    validate_artifact,
    write_artifact,
)
from app.errors import ArtifactInvalidError

RULE_BODY = "\n\n".join(f"{section}\n\nContent." for section in REQUIRED_RULE_SECTIONS)


def _spec(**overrides) -> ArtifactInput:
    values = dict(
        id="no-retry-storms",
        artifact_type="rule",
        category="backend-code",
        title="Do not do retries",
        severity="high",
        forced=True,
        when_to_use="Use when writing network or queue client code.",
        applies_when=AppliesWhenInput(intents=["retries", "backoff", "resilience"]),
        source_url="https://august.mataroa.blog/blog/writing-acceptable-backend-code/",
        source_ref="writing-acceptable-backend-code#1",
        body=RULE_BODY,
    )
    values.update(overrides)
    return ArtifactInput(**values)


class TestCorpusWriter:
    def test_written_artifact_round_trips_through_corpus_reader(self, tmp_path):
        # arrange
        spec = _spec()
        path = artifact_path(str(tmp_path), spec)
        rendered = render_markdown(spec)
        expected = validate_artifact(spec, "global", path, rendered)

        # act
        write_artifact(path, rendered)
        artifacts = CorpusReader(str(tmp_path)).read()

        # assert
        assert len(artifacts) == 1
        loaded = artifacts[0]
        assert loaded.id == expected.id
        assert loaded.forced is True
        assert loaded.applies_when.intents == ["retries", "backoff", "resilience"]
        assert loaded.body.strip() == RULE_BODY.strip()

    def test_provenance_fields_survive_the_round_trip(self, tmp_path):
        # arrange
        spec = _spec()
        path = artifact_path(str(tmp_path), spec)

        # act
        write_artifact(path, render_markdown(spec))
        loaded = CorpusReader(str(tmp_path)).read()[0]

        # assert
        assert loaded.source_url == spec.source_url
        assert loaded.source_ref == spec.source_ref

    def test_rule_missing_required_sections_is_rejected(self):
        # arrange
        spec = _spec(body="## What this rule says\n\nOnly one section.")

        # act / assert
        with pytest.raises(ArtifactInvalidError):
            check_rule_sections(spec)

    def test_skill_body_has_no_required_sections(self):
        # arrange
        spec = _spec(artifact_type="skill", severity=None, body="## Steps\n\n1. Do it.")

        # act / assert: no raise
        check_rule_sections(spec)
