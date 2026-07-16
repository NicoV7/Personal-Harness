"""Typed hook event payloads and the decision shape handlers return.

Hook behaviors evolve (pre-tool materialization via Redis is a planned
extension), so hooks are a pipeline over these typed events rather than
conditionals in route handlers. Adding behavior means adding a handler,
never editing routes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class UserPromptSubmit:
    session_id: str | None
    prompt: str
    cwd: str | None = None


@dataclass(frozen=True)
class PreToolUse:
    session_id: str | None
    tool_name: str
    tool_input: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PostToolUse:
    session_id: str | None
    tool_name: str
    tool_input: dict[str, Any] = field(default_factory=dict)
    tool_response: dict[str, Any] = field(default_factory=dict)
    # Full plan-file text attached host-side by the post-tool-use shim for
    # plan-glob paths: Edit/MultiEdit payloads carry only fragments and the
    # server cannot read host files (Docker boundary).
    plan_content: str | None = None


@dataclass(frozen=True)
class Stop:
    session_id: str | None


@dataclass(frozen=True)
class SessionEnd:
    session_id: str | None


HookEvent = UserPromptSubmit | PreToolUse | PostToolUse | Stop | SessionEnd


@dataclass(frozen=True)
class HookDecision:
    """What one handler decided. The chain merges decisions: the first
    deny wins; additional_context strings are concatenated in chain order."""

    deny: bool = False
    reason: str | None = None
    error_code: str | None = None
    additional_context: str | None = None

    @staticmethod
    def allow(context: str | None = None) -> "HookDecision":
        return HookDecision(additional_context=context)

    @staticmethod
    def block(reason: str, error_code: str) -> "HookDecision":
        return HookDecision(deny=True, reason=reason, error_code=error_code)
