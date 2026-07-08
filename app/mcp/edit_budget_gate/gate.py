"""Edit-budget hook handlers (locked decision 8).

Granularity comes from Settings (BETTERAI_EDIT_GRANULARITY, explicit):
  function  the second mutating call in a turn is denied (BAI-703)
  file      unlimited edits to the first touched file; a second distinct
            file is denied (BAI-703)
  none      the gate has no opinion

The Stop handler explicitly ALLOWS in active modes — stopping to discuss
the next edit with the user is the entire point of the gate, so it must
never fight the read gate's stop-block.
"""

from __future__ import annotations

import os
from typing import Any

from app.deps import CallMeta, Deps
from app.errors import Errors
from app.hooks.events import HookDecision, HookEvent, PostToolUse, PreToolUse, Stop
from app.mcp import registry
from app.mcp.edit_budget_gate import store as budget_store
from app.mcp.plan_manifest_gate.gate import mutated_paths

ERROR_CODE = "BAI-703"
GATE_NAME = "edit_budget_gate"
GRANULARITY_OFF = "none"


def _hook_meta(session_id: str | None, tool_call_id: str) -> CallMeta:
    return CallMeta(
        agent_session_id=session_id,
        parent_agent_session_id=None,
        subagent_class="main",
        tool_call_id=tool_call_id,
    )


def _deny(event: PreToolUse, deps: Deps, granularity: str, path: str | None) -> HookDecision:
    reason = str(Errors.edit_budget_exceeded(granularity))
    payload: dict[str, Any] = {
        "gate": GATE_NAME,
        "denied_tool": event.tool_name,
        "reason": reason,
    }
    if path is not None:
        payload["denied_path"] = path
    deps.audit.record("gate_denial", payload, _hook_meta(event.session_id, "hook.pre_tool_use"))
    return HookDecision.block(reason, ERROR_CODE)


class DenyOverBudgetHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PreToolUse)
        granularity = deps.settings.edit_granularity
        if granularity == GRANULARITY_OFF or not event.session_id:
            return None
        if event.tool_name not in registry.MUTATING_TOOL_NAMES:
            return None
        if granularity == "function":
            return self._check_function_budget(event, deps)
        return self._check_file_budget(event, deps)

    def _check_function_budget(self, event: PreToolUse, deps: Deps) -> HookDecision | None:
        if budget_store.mutation_count(deps.store, event.session_id) < 1:
            return None
        return _deny(event, deps, "function", None)

    def _check_file_budget(self, event: PreToolUse, deps: Deps) -> HookDecision | None:
        touched = budget_store.touched_files(deps.store, event.session_id)
        if not touched:
            return None
        for path in mutated_paths(event.tool_input):
            if os.path.normpath(path) not in touched:
                return _deny(event, deps, "file", path)
        return None


class RecordMutationHandler:
    """PostToolUse only fires for calls that actually ran, so denied
    calls never consume budget (documented choice per plan)."""

    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PostToolUse)
        if deps.settings.edit_granularity == GRANULARITY_OFF or not event.session_id:
            return None
        if event.tool_name not in registry.MUTATING_TOOL_NAMES:
            return None
        if _tool_failed(event.tool_response):
            return None
        budget_store.record_mutation(
            deps.store, event.session_id, mutated_paths(event.tool_input)
        )
        return None


class NeverBlockStopHandler:
    """Explicit allow (not merely no-opinion) in active modes: the plan
    mandates that stopping to converse is never blocked by this gate."""

    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, Stop)
        if deps.settings.edit_granularity == GRANULARITY_OFF:
            return None
        return HookDecision.allow()


def _tool_failed(tool_response: dict[str, Any]) -> bool:
    return bool(tool_response.get("error") or tool_response.get("is_error"))


HANDLERS = {
    PreToolUse: DenyOverBudgetHandler(),
    PostToolUse: RecordMutationHandler(),
    Stop: NeverBlockStopHandler(),
}
