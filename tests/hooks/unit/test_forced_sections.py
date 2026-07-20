"""Forced skills render separately from matched skills in served context."""

from __future__ import annotations

from app.hooks.routes import _prompt_context, _served_section
from tests.mcp.gate_helpers import make_skill


def test_prompt_context_groups_forced_before_matched_with_distinct_labels():
    # arrange
    forced = make_skill("i-have-adhd", forced=True)
    matched = make_skill("write-pytest-fixture")

    # act
    context = _prompt_context([forced, matched], warning=None)

    # assert: distinct labels, forced first
    forced_header = "## BetterAI FORCED skill (always on): i-have-adhd"
    matched_header = "## BetterAI required skill: write-pytest-fixture"
    assert forced_header in context
    assert matched_header in context
    assert context.index(forced_header) < context.index(matched_header)


def test_prompt_context_without_forced_keeps_plain_required_sections():
    # act
    context = _prompt_context([make_skill("write-pytest-fixture")], warning=None)

    # assert
    assert "## BetterAI required skill: write-pytest-fixture" in context
    assert "FORCED skill" not in context


def test_served_section_default_label_is_unchanged():
    # act
    section = _served_section(make_skill("rename-safely"))

    # assert: default callers keep the historical header
    assert section.startswith("## BetterAI required skill: rename-safely")
