"""Ordered handler chains per hook event type.

A handler is any object with `handle(event, deps) -> HookDecision | None`.
Returning None means "no opinion". The chain runs handlers in registration
order; the FIRST deny short-circuits, additional_context strings from
allowing handlers are concatenated. Registration order is owned by
app/mcp/registry.py so the composition is reviewable in one place.
"""

from __future__ import annotations

from typing import Any, Protocol

from app.hooks.events import HookDecision, HookEvent


class HookHandler(Protocol):
    def handle(self, event: HookEvent, deps: Any) -> HookDecision | None: ...


class HookChain:
    def __init__(self) -> None:
        self._handlers: dict[type, list[HookHandler]] = {}

    def register(self, event_type: type, handler: HookHandler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def run(self, event: HookEvent, deps: Any) -> HookDecision:
        contexts: list[str] = []
        for handler in self._handlers.get(type(event), []):
            decision = handler.handle(event, deps)
            if decision is None:
                continue
            if decision.deny:
                return decision
            if decision.additional_context:
                contexts.append(decision.additional_context)
        merged = "\n\n".join(contexts) if contexts else None
        return HookDecision.allow(merged)
