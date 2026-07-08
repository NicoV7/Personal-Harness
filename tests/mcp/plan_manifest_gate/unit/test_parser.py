"""Grammar tests for the '## Files to touch' section parser."""

from __future__ import annotations

from app.mcp.plan_manifest_gate.parser import parse_files_to_touch

PLAN_HAPPY = """# Plan

## Files to touch

- app/mcp/foo.py — handle, parse
- app/mcp/bar.py - render
- app/mcp/baz.py

## Risks
- something unrelated - not an entry
"""


def test_parses_em_dash_hyphen_and_bare_entries():
    # act
    parsed = parse_files_to_touch(PLAN_HAPPY)

    # assert
    assert parsed.ok is True
    assert [entry.path for entry in parsed.entries] == [
        "app/mcp/foo.py",
        "app/mcp/bar.py",
        "app/mcp/baz.py",
    ]
    assert parsed.entries[0].functions == "handle, parse"
    assert parsed.entries[1].functions == "render"
    assert parsed.entries[2].functions == ""


def test_section_stops_at_next_heading():
    # act
    parsed = parse_files_to_touch(PLAN_HAPPY)

    # assert: the entry under '## Risks' is not part of the manifest
    assert len(parsed.entries) == 3


def test_justify_line_marks_previous_entry():
    # arrange
    plan = (
        "## Files to touch\n"
        "- app/a.py — run\n"
        "- app/b.py — helper\n"
        "  justify: discovered during implementation\n"
    )

    # act
    parsed = parse_files_to_touch(plan)

    # assert
    assert parsed.ok is True
    assert parsed.entries[0].justified is False
    assert parsed.entries[1].justified is True


def test_missing_section_fails_parse():
    # act
    parsed = parse_files_to_touch("# Plan\n\n## Context\n- app/a.py\n")

    # assert
    assert parsed.ok is False
    assert "Files to touch" in parsed.error


def test_section_without_entries_fails_parse():
    # act
    parsed = parse_files_to_touch("## Files to touch\n\nprose only, no bullets\n")

    # assert
    assert parsed.ok is False


def test_empty_bullet_fails_parse():
    # act
    parsed = parse_files_to_touch("## Files to touch\n- \n")

    # assert
    assert parsed.ok is False


def test_justify_before_any_entry_fails_parse():
    # act
    parsed = parse_files_to_touch("## Files to touch\njustify: nope\n- app/a.py\n")

    # assert
    assert parsed.ok is False


def test_backticked_paths_are_unwrapped():
    # act
    parsed = parse_files_to_touch("## Files to touch\n- `app/a.py` — run\n")

    # assert
    assert parsed.ok is True
    assert parsed.entries[0].path == "app/a.py"
