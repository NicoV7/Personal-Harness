"""Read-gate hook handlers.

Behavior ported from src/hooks/routes.ts + src/runtime/read-receipts.ts:
ordinary tools are denied while required skills are unread, bootstrap
tools (the BetterAI surface itself) always pass so the agent can satisfy
the gate, Stop blocks exactly once, and a null session_id disables
gating entirely.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps
from app.errors import Errors, ReadGateError
from app.hooks.events import HookDecision, HookEvent, PreToolUse, SessionEnd, Stop, UserPromptSubmit
from app.mcp import registry
from app.mcp.read_gate import store as read_store

ERROR_CODE = ReadGateError.code
GATE_NAME = "read_gate"


def missing_skill_reason(skill_ids: list[str]) -> str:
    """TS reason text plus the v0.2 instruction (read_skill -> get_skill);
    sourced from the typed-error registry so the code stays enumerable."""
    return str(Errors.read_gate_denied(skill_ids))


def _is_bootstrap_tool(tool_name: str) -> bool:
    normalized = tool_name.lower()
    return any(fragment in normalized for fragment in registry.BOOTSTRAP_TOOL_FRAGMENTS)


def _hook_meta(session_id: str | None, tool_call_id: str) -> CallMeta:
    return CallMeta(
        agent_session_id=session_id,
        parent_agent_session_id=None,
        subagent_class="main",
        tool_call_id=tool_call_id,
    )


class BeginTurnHandler:
    """UserPromptSubmit resets all turn-scoped gate state. The retrieval
    that fills the new required set lives in hooks/routes.py, not here."""

    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, UserPromptSubmit)
        if not event.session_id:
            return None
        deps.store.begin_turn(event.session_id, registry.TURN_NAMESPACES)
        return None


class DenyUntilReadHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PreToolUse)
        if not event.session_id or _is_bootstrap_tool(event.tool_name):
            return None
        missing = read_store.missing(deps.store, event.session_id)
        if not missing:
            return None
        reason = missing_skill_reason(missing)
        deps.audit.record(
            "gate_denial",
            {"gate": GATE_NAME, "denied_tool": event.tool_name, "reason": reason},
            _hook_meta(event.session_id, "hook.pre_tool_use"),
        )
        return HookDecision.block(reason, ERROR_CODE)


class StopOnceHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, Stop)
        if not read_store.should_block_stop_once(deps.store, event.session_id):
            return None
        missing = read_store.missing(deps.store, event.session_id)
        reason = missing_skill_reason(missing)
        deps.audit.record(
            "gate_denial",
            {"gate": GATE_NAME, "denied_tool": "Stop", "reason": reason},
            _hook_meta(event.session_id, "hook.stop"),
        )
        return HookDecision.block(reason, ERROR_CODE)


class ClearSessionHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, SessionEnd)
        if event.session_id:
            deps.store.clear_session(event.session_id)
        return None


HANDLERS = {
    UserPromptSubmit: BeginTurnHandler(),
    PreToolUse: DenyUntilReadHandler(),
    Stop: StopOnceHandler(),
    SessionEnd: ClearSessionHandler(),
}
