"""Line-for-line port of the TS read-gate scenarios
(src/__tests__/hooks-read-gate.test.ts) at the gate-handler level."""

from __future__ import annotations

from app.hooks.events import PreToolUse, SessionEnd, Stop, UserPromptSubmit
from app.mcp import registry
from app.mcp.read_gate import store as read_store
from app.mcp.read_gate.gate import HANDLERS
from tests.mcp.gate_helpers import audit_events, make_deps, make_settings

SESSION = "sess-1"


def _begin_turn(deps, session_id, required):
    HANDLERS[UserPromptSubmit].handle(
        UserPromptSubmit(session_id=session_id, prompt="rename a variable safely"), deps
    )
    read_store.set_required(deps.store, session_id, required)


def test_blocks_mutating_tools_until_required_skills_are_read(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    blocked = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Edit"), deps
    )
    read_store.mark_read(deps.store, SESSION, "rename-safely")
    allowed = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Edit"), deps
    )

    # assert
    assert blocked is not None and blocked.deny is True
    assert "rename-safely" in blocked.reason
    assert "mcp__betterai__get_skill" in blocked.reason
    assert blocked.error_code == "BAI-700"
    assert allowed is None


def test_read_only_tools_and_loader_always_pass_while_unread(tmp_path):
    # arrange: the deadlock regression — a session with zero loaded MCP
    # tools must still be able to Read/search/load tools
    deps = make_deps(tmp_path)
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    decisions = [
        HANDLERS[PreToolUse].handle(
            PreToolUse(session_id=SESSION, tool_name=name), deps
        )
        for name in ("Read", "ToolSearch", "Bash", "Grep", "Agent")
    ]

    # assert
    assert decisions == [None, None, None, None, None]


def test_read_gate_off_disables_deny_only(tmp_path):
    # arrange: explicit escape hatch — deny off, receipts still tracked
    deps = make_deps(tmp_path, settings=make_settings(tmp_path, read_gate="off"))
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    allowed = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Edit"), deps
    )

    # assert
    assert allowed is None
    assert read_store.missing(deps.store, SESSION) == ["rename-safely"]


def test_bootstrap_tools_allowed_while_blocked(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    decisions = [
        HANDLERS[PreToolUse].handle(
            PreToolUse(session_id=SESSION, tool_name=name), deps
        )
        for name in (
            "mcp__betterai__get_skill",
            "mcp__betterai__query_skills",
            "mcp__betterai__list_skills",
        )
    ]

    # assert
    assert decisions == [None, None, None]


def test_stop_blocks_exactly_once_when_skills_unread(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, "sess-2", ["rename-safely"])

    # act
    first = HANDLERS[Stop].handle(Stop(session_id="sess-2"), deps)
    second = HANDLERS[Stop].handle(Stop(session_id="sess-2"), deps)

    # assert
    assert first is not None and first.deny is True
    assert "rename-safely" in first.reason
    assert second is None


def test_stop_passes_when_nothing_missing(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, "sess-2", [])

    # act
    decision = HANDLERS[Stop].handle(Stop(session_id="sess-2"), deps)

    # assert
    assert decision is None


def test_new_prompt_resets_required_skill_receipts(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, "sess-3", ["rename-safely"])
    blocked = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id="sess-3", tool_name="Edit"), deps
    )

    # act: a non-matching prompt begins a new turn with an empty required set
    _begin_turn(deps, "sess-3", [])
    allowed = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id="sess-3", tool_name="Edit"), deps
    )

    # assert
    assert blocked is not None and blocked.deny is True
    assert read_store.missing(deps.store, "sess-3") == []
    assert allowed is None


def test_null_session_disables_gating_entirely(tmp_path):
    # arrange
    deps = make_deps(tmp_path)

    # act
    prompt = HANDLERS[UserPromptSubmit].handle(
        UserPromptSubmit(session_id=None, prompt="rename"), deps
    )
    pre = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=None, tool_name="Read"), deps
    )
    stop = HANDLERS[Stop].handle(Stop(session_id=None), deps)

    # assert
    assert prompt is None and pre is None and stop is None


def test_session_end_clears_state(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    HANDLERS[SessionEnd].handle(SessionEnd(session_id=SESSION), deps)

    # assert
    assert read_store.missing(deps.store, SESSION) == []


def test_denial_writes_gate_denial_audit_event(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    _begin_turn(deps, SESSION, ["rename-safely"])

    # act
    HANDLERS[PreToolUse].handle(PreToolUse(session_id=SESSION, tool_name="Edit"), deps)

    # assert
    events = audit_events(deps)
    assert len(events) == 1
    assert events[0]["event_type"] == "gate_denial"
    assert events[0]["payload"]["gate"] == "read_gate"
    assert events[0]["payload"]["denied_tool"] == "Edit"
    assert events[0]["agent_session_id"] == SESSION


def test_turn_namespaces_cover_read_gate_state():
    # assert: the frozen registry clears both gate namespaces per turn
    assert "read_gate" in registry.TURN_NAMESPACES
    assert "stop_state" in registry.TURN_NAMESPACES
