"""Retrieval-receipt hook handler.

Evidence-based contract: deny only when a session the prompt hook HAS
served (prompt_seen) lacks this turn's receipt — a genuinely broken
turn. A session with no delivery evidence is allowed WITH a loud
warning: its hook wiring never ran, so a deny would be an unrecoverable
lockup with no in-turn remedy (post-mortem class #3). A null session_id
disables gating; BETTERAI_RECEIPT_GATE=off is the deny-only escape
hatch — receipts and audit still run.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps
from app.errors import Errors
from app.hooks.events import HookDecision, HookEvent, PreToolUse
from app.mcp import registry
from app.mcp.retrieval_receipt_gate import store as receipt_store

ERROR_CODE = "BAI-701"
GATE_NAME = "retrieval_receipt_gate"

NO_EVIDENCE_WARNING = (
    "BetterAI WARNING: this session has never received a prompt-hook "
    "delivery — hook wiring may be broken (see ~/.betterai/hook-errors.log). "
    "Skills are NOT being served or enforced for this session."
)


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
        if not receipt_store.prompt_seen(deps.store, event.session_id):
            deps.audit.record(
                "gate_bypass_no_evidence",
                {"gate": GATE_NAME, "tool": event.tool_name},
                CallMeta(
                    agent_session_id=event.session_id,
                    parent_agent_session_id=None,
                    subagent_class="main",
                    tool_call_id="hook.pre_tool_use",
                ),
            )
            return HookDecision.allow(NO_EVIDENCE_WARNING)
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
