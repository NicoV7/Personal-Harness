"""Retrieval-receipt hook handler.

Locked decision 5: PreToolUse denies mutating tools until a retrieval
receipt exists for this turn (normally recorded by the prompt hook at
delivery). A null session_id disables gating (matches the read-gate
contract). BETTERAI_RECEIPT_GATE=off is the explicit escape hatch —
deny only; receipts and audit still run.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps
from app.errors import Errors
from app.hooks.events import HookDecision, HookEvent, PreToolUse
from app.mcp import registry
from app.mcp.retrieval_receipt_gate import store as receipt_store

ERROR_CODE = "BAI-701"
GATE_NAME = "retrieval_receipt_gate"


class DenyWithoutReceiptHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PreToolUse)
        if not event.session_id:
            return None
        if event.tool_name not in registry.MUTATING_TOOL_NAMES:
            return None
        if deps.settings.receipt_gate == "off":
            return None
        if receipt_store.has_retrieved(deps.store, event.session_id):
            return None
        reason = str(Errors.receipt_missing(event.tool_name))
        deps.audit.record(
            "gate_denial",
            {"gate": GATE_NAME, "denied_tool": event.tool_name, "reason": reason},
            CallMeta(
                agent_session_id=event.session_id,
                parent_agent_session_id=None,
                subagent_class="main",
                tool_call_id="hook.pre_tool_use",
            ),
        )
        return HookDecision.block(reason, ERROR_CODE)


HANDLERS = {PreToolUse: DenyWithoutReceiptHandler()}
