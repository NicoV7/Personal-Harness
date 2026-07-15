"""Artifact settings/settings_schema: declaration, validation, round-trip."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.corpus.reader import parse_artifact_text
from app.corpus.schema import Artifact, OptionSpec, invalid_setting
from app.corpus.writer import ArtifactInput, render_markdown

LEVEL_SPEC = {
    "type": "string",
    "pattern": "^(default|none|tokens:[1-9][0-9]*|lines:[1-9][0-9]*)$",
    "description": "Comment verbosity level.",
    "default": "default",
}


class TestArtifactValidation:
    def test_settings_matching_schema_accepted(self):
        artifact = Artifact(
            id="concise-comments",
            artifact_type="rule",
            title="t",
            category="STANDARDS",
            settings_schema={"level": LEVEL_SPEC},
            settings={"level": "lines:2"},
        )
        assert artifact.settings == {"level": "lines:2"}

    def test_settings_without_schema_rejected(self):
        with pytest.raises(ValidationError, match="no settings_schema"):
            Artifact(
                id="x-rule",
                artifact_type="rule",
                title="t",
                category="STANDARDS",
                settings={"level": "none"},
            )

    def test_value_violating_pattern_rejected(self):
        with pytest.raises(ValidationError, match="must match"):
            Artifact(
                id="x-rule",
                artifact_type="rule",
                title="t",
                category="STANDARDS",
                settings_schema={"level": LEVEL_SPEC},
                settings={"level": "verbose"},
            )

    def test_enum_option_requires_choices(self):
        with pytest.raises(ValidationError, match="choices"):
            OptionSpec(type="enum", description="d", default="a")


class TestInvalidSetting:
    def test_unknown_key_named(self):
        schema = {"level": OptionSpec(**LEVEL_SPEC)}
        assert "unknown setting" in invalid_setting(schema, "volume", "11")

    def test_int_option_requires_integer(self):
        schema = {"budget": OptionSpec(type="int", description="d", default="1")}
        assert invalid_setting(schema, "budget", "ten") is not None
        assert invalid_setting(schema, "budget", "10") is None

    def test_enum_option_checks_choices(self):
        schema = {
            "mode": OptionSpec(type="enum", choices=["a", "b"], description="d", default="a")
        }
        assert invalid_setting(schema, "mode", "c") is not None
        assert invalid_setting(schema, "mode", "b") is None


class TestWriterRoundTrip:
    def test_settings_survive_render_and_parse(self):
        spec = ArtifactInput(
            id="concise-comments",
            artifact_type="rule",
            category="STANDARDS",
            title="Comments explain WHY",
            severity="medium",
            settings_schema={"level": OptionSpec(**LEVEL_SPEC)},
            settings={"level": "tokens:150"},
            body=(
                "## What this rule says\n\nx\n\n## Why it matters\n\nx\n\n"
                "## When this applies\n\nx\n\n## What good looks like\n\nx\n\n"
                "## Anti-patterns\n\nx\n"
            ),
        )
        rendered = render_markdown(spec)
        artifact = parse_artifact_text(
            rendered, artifact_type="rule", scope="global", source_path="/tmp/x.md"
        )
        assert artifact.settings == {"level": "tokens:150"}
        assert artifact.settings_schema["level"].pattern == LEVEL_SPEC["pattern"]
