"""Edit-budget gate: function/file/none granularity semantics (BAI-703)."""

from __future__ import annotations

from app.hooks.events import PostToolUse, PreToolUse, Stop
from app.mcp import registry
from app.mcp.edit_budget_gate.gate import HANDLERS
from tests.mcp.gate_helpers import audit_events, make_deps, make_settings

SESSION = "sess-budget"


def _deps(tmp_path, granularity):
    return make_deps(
        tmp_path, settings=make_settings(tmp_path, edit_granularity=granularity)
    )


def _pre(deps, tool_name="Edit", path="/repo/app/a.py"):
    return HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name=tool_name, tool_input={"file_path": path}),
        deps,
    )


def _post(deps, tool_name="Edit", path="/repo/app/a.py", response=None):
    return HANDLERS[PostToolUse].handle(
        PostToolUse(
            session_id=SESSION,
            tool_name=tool_name,
            tool_input={"file_path": path},
            tool_response=response or {},
        ),
        deps,
    )


def test_none_granularity_has_no_opinion(tmp_path):
    # arrange
    deps = _deps(tmp_path, "none")

    # act
    first = _pre(deps)
    _post(deps)
    second = _pre(deps)
    stop = HANDLERS[Stop].handle(Stop(session_id=SESSION), deps)

    # assert
    assert first is None and second is None and stop is None


def test_function_granularity_denies_second_mutating_call(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")

    # act
    first = _pre(deps, tool_name="Write")
    _post(deps, tool_name="Write")
    second = _pre(deps, tool_name="Edit", path="/repo/app/a.py")

    # assert
    assert first is None
    assert second is not None and second.deny is True
    assert second.error_code == "BAI-703"
    assert "stop and discuss" in second.reason


def test_denied_calls_do_not_consume_budget(tmp_path):
    # arrange: PostToolUse never fires for a denied call, so budget stays
    deps = _deps(tmp_path, "function")

    # act
    first = _pre(deps)
    second = _pre(deps)

    # assert
    assert first is None and second is None


def test_file_granularity_allows_unlimited_edits_to_first_file(tmp_path):
    # arrange
    deps = _deps(tmp_path, "file")

    # act
    _post(deps, path="/repo/app/a.py")
    _post(deps, path="/repo/app/a.py")
    third = _pre(deps, path="/repo/app/a.py")

    # assert
    assert third is None


def test_file_granularity_denies_second_distinct_file(tmp_path):
    # arrange
    deps = _deps(tmp_path, "file")
    _post(deps, path="/repo/app/a.py")

    # act
    decision = _pre(deps, path="/repo/app/b.py")

    # assert
    assert decision is not None and decision.deny is True
    assert decision.error_code == "BAI-703"
    events = audit_events(deps)
    assert events[-1]["payload"]["gate"] == "edit_budget_gate"
    assert events[-1]["payload"]["denied_path"] == "/repo/app/b.py"


def test_failed_tool_response_does_not_consume_budget(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")

    # act
    _post(deps, response={"error": "write failed"})
    decision = _pre(deps)

    # assert
    assert decision is None


def test_non_mutating_tools_are_ignored(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")

    # act
    _post(deps, tool_name="Read")
    decision = _pre(deps, tool_name="Read")

    # assert
    assert decision is None


def test_stop_is_explicitly_allowed_in_active_modes(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")
    _post(deps)

    # act
    decision = HANDLERS[Stop].handle(Stop(session_id=SESSION), deps)

    # assert: explicit allow (not merely no-opinion) and never a deny
    assert decision is not None
    assert decision.deny is False


def test_null_session_has_no_opinion(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=None, tool_name="Edit", tool_input={"file_path": "/a.py"}),
        deps,
    )

    # assert
    assert decision is None


def test_new_turn_resets_budget(tmp_path):
    # arrange
    deps = _deps(tmp_path, "function")
    _post(deps)

    # act
    deps.store.begin_turn(SESSION, registry.TURN_NAMESPACES)
    decision = _pre(deps)

    # assert
    assert decision is None
