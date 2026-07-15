"""Retrieval-receipt gate: mutating tools require query_skills this turn."""

from __future__ import annotations

from app.hooks.events import PreToolUse
from app.mcp import registry
from app.mcp.retrieval_receipt_gate import store as receipt_store
from app.mcp.retrieval_receipt_gate.gate import HANDLERS
from tests.mcp.gate_helpers import audit_events, make_deps, make_settings

SESSION = "sess-receipt"


def test_mutating_tool_denied_without_receipt(tmp_path):
    # arrange: the session HAS delivery evidence, so a missing receipt
    # means a genuinely broken turn — the deny path
    deps = make_deps(tmp_path)
    receipt_store.mark_prompt_seen(deps.store, SESSION)

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Write"), deps
    )

    # assert
    assert decision is not None and decision.deny is True
    assert decision.error_code == "BAI-701"
    assert "no retrieval receipt" in decision.reason
    assert "BETTERAI_RECEIPT_GATE=off" in decision.reason


def test_never_served_session_allowed_with_wiring_warning(tmp_path):
    # arrange: no prompt delivery ever recorded for this session
    deps = make_deps(tmp_path)

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id="never-served", tool_name="Write"), deps
    )

    # assert: allow, loudly — a deny would have no in-turn remedy
    assert decision is not None and decision.deny is False
    assert "hook wiring" in decision.additional_context
    events = audit_events(deps)
    assert events[-1]["event_type"] == "gate_bypass_no_evidence"


def test_receipt_gate_off_disables_deny_only(tmp_path):
    # arrange
    deps = make_deps(tmp_path, settings=make_settings(tmp_path, receipt_gate="off"))

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Write"), deps
    )

    # assert
    assert decision is None
    assert audit_events(deps) == []


def test_mutating_tool_allowed_after_receipt(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    receipt_store.mark_retrieved(deps.store, SESSION)

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Write"), deps
    )

    # assert
    assert decision is None


def test_non_mutating_tool_never_gated(tmp_path):
    # arrange
    deps = make_deps(tmp_path)

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Read"), deps
    )

    # assert
    assert decision is None


def test_null_session_allows(tmp_path):
    # arrange
    deps = make_deps(tmp_path)

    # act
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=None, tool_name="Write"), deps
    )

    # assert
    assert decision is None


def test_new_turn_clears_receipt(tmp_path):
    # arrange: evidence survives begin_turn, the receipt does not
    deps = make_deps(tmp_path)
    receipt_store.mark_prompt_seen(deps.store, SESSION)
    receipt_store.mark_retrieved(deps.store, SESSION)

    # act
    deps.store.begin_turn(SESSION, registry.TURN_NAMESPACES)
    decision = HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="Edit"), deps
    )

    # assert
    assert receipt_store.has_retrieved(deps.store, SESSION) is False
    assert decision is not None and decision.deny is True


def test_denial_writes_gate_denial_audit_event(tmp_path):
    # arrange
    deps = make_deps(tmp_path)
    receipt_store.mark_prompt_seen(deps.store, SESSION)

    # act
    HANDLERS[PreToolUse].handle(
        PreToolUse(session_id=SESSION, tool_name="MultiEdit"), deps
    )

    # assert
    events = audit_events(deps)
    assert len(events) == 1
    assert events[0]["event_type"] == "gate_denial"
    assert events[0]["payload"]["gate"] == "retrieval_receipt_gate"
    assert events[0]["payload"]["denied_tool"] == "MultiEdit"
