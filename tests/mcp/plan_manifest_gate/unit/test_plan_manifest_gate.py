"""Plan-manifest gate: capture, extension via justify:, and BAI-702 denial."""

from __future__ import annotations

from app.hooks.events import PostToolUse, PreToolUse, SessionEnd
from app.mcp.plan_manifest_gate import store as manifest_store
from app.mcp.plan_manifest_gate.gate import HANDLERS
from tests.mcp.gate_helpers import audit_events, make_deps, make_settings

SESSION = "sess-plan"
PLAN_PATH = "/repo/plans/feature.plan.md"
PLAN_CONTENT = (
    "# Plan\n\n## Files to touch\n\n"
    "- app/service/client.py — request, handle_error\n"
    "- app/service/config.py\n"
    "- app/service/vendor/**\n"
)


def _deps(tmp_path):
    return make_deps(tmp_path, settings=make_settings(tmp_path, plan_glob="*.plan.md"))


def _capture(deps, content=PLAN_CONTENT, path=PLAN_PATH):
    return HANDLERS[PostToolUse].handle(
        PostToolUse(
            session_id=SESSION,
            tool_name="Write",
            tool_input={"file_path": path, "content": content},
        ),
        deps,
    )


def _pre(deps, tool_input, tool_name="Edit"):
    return HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name=tool_name, tool_input=tool_input), deps
    )


def test_plan_write_captures_manifest_and_activates(tmp_path):
    # arrange
    deps = _deps(tmp_path)

    # act
    decision = _capture(deps)

    # assert
    assert decision is not None and decision.deny is False
    assert "captured" in decision.additional_context
    assert manifest_store.is_active(deps.store, SESSION) is True
    assert len(manifest_store.entries(deps.store, SESSION)) == 3


def test_edit_inside_manifest_allowed_via_relative_suffix_match(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    decision = _pre(deps, {"file_path": "/repo/app/service/client.py"})

    # assert
    assert decision is None


def test_edit_outside_manifest_denied_with_bai702_and_audited(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    decision = _pre(deps, {"file_path": "/repo/app/other/module.py"})

    # assert
    assert decision is not None and decision.deny is True
    assert decision.error_code == "BAI-702"
    assert "/repo/app/other/module.py" in decision.reason
    events = audit_events(deps)
    assert events[-1]["event_type"] == "gate_denial"
    assert events[-1]["payload"]["gate"] == "plan_manifest_gate"
    assert events[-1]["payload"]["denied_path"] == "/repo/app/other/module.py"


def test_declared_dir_glob_allows_new_files_under_it(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    decision = _pre(deps, {"file_path": "/repo/app/service/vendor/new_adapter.py"})

    # assert
    assert decision is None


def test_plan_file_itself_is_always_editable(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    decision = _pre(deps, {"file_path": PLAN_PATH})

    # assert
    assert decision is None


def test_extension_without_justify_is_not_registered_and_warned(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    extended = _capture(deps, PLAN_CONTENT + "- app/sneaky/extra.py\n")
    denied = _pre(deps, {"file_path": "/repo/app/sneaky/extra.py"})

    # assert
    assert "justify" in extended.additional_context
    assert denied is not None and denied.deny is True


def test_justified_extension_is_registered_audited_and_warned(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    extended = _capture(
        deps,
        PLAN_CONTENT + "- app/extra/late.py — patch\n  justify: found during impl\n",
    )
    allowed = _pre(deps, {"file_path": "/repo/app/extra/late.py"})

    # assert
    assert "EXTENDED" in extended.additional_context
    assert allowed is None
    extend_events = [
        event for event in audit_events(deps) if event["event_type"] == "plan_manifest_extend"
    ]
    assert len(extend_events) == 1
    assert extend_events[0]["payload"]["path"] == "app/extra/late.py"


def test_parse_failure_deactivates_gate_with_warning_never_denies(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    warned = _capture(deps, "# Plan without the required section\n")
    decision = _pre(deps, {"file_path": "/repo/anything/at_all.py"})

    # assert
    assert warned.deny is False
    assert "INACTIVE" in warned.additional_context
    assert decision is None


def test_multiedit_denies_when_any_path_is_outside(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    decision = _pre(
        deps,
        {
            "file_path": "/repo/app/service/client.py",
            "edits": [{"file_path": "/repo/app/outside/helper.py"}],
        },
        tool_name="MultiEdit",
    )

    # assert
    assert decision is not None and decision.deny is True
    assert "outside/helper.py" in decision.reason


def test_gate_has_no_opinion_before_capture(tmp_path):
    # arrange
    deps = _deps(tmp_path)

    # act
    decision = _pre(deps, {"file_path": "/repo/app/anything.py"})

    # assert
    assert decision is None


def test_session_end_clears_manifest(tmp_path):
    # arrange
    deps = _deps(tmp_path)
    _capture(deps)

    # act
    HANDLERS[SessionEnd].handle(SessionEnd(session_id=SESSION), deps)

    # assert
    assert manifest_store.is_active(deps.store, SESSION) is False
    assert manifest_store.entries(deps.store, SESSION) == []
