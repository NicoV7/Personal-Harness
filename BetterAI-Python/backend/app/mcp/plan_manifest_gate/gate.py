"""Plan-manifest hook handlers.

PostToolUse on a plan-file write captures/extends the manifest; PreToolUse
denies mutating tools targeting paths outside it (BAI-702). Capture NEVER
denies: a malformed section deactivates the gate with a visible warning,
because a silent block over a parse guess would brick sessions (plan risk
table). Extensions (paths added after first capture) require a justify:
line — justified ones are audited, unjustified ones are simply not
registered, so the deny handler enforces the requirement.
"""

from __future__ import annotations

from typing import Any

from app.deps import CallMeta, Deps
from app.errors import Errors
from app.hooks.events import HookDecision, HookEvent, PostToolUse, PreToolUse, SessionEnd
from app.mcp import registry
from app.mcp.plan_manifest_gate import store as manifest_store
from app.mcp.plan_manifest_gate.parser import ManifestEntry, parse_files_to_touch

ERROR_CODE = "BAI-702"
GATE_NAME = "plan_manifest_gate"


def _hook_meta(session_id: str | None, tool_call_id: str) -> CallMeta:
    return CallMeta(
        agent_session_id=session_id,
        parent_agent_session_id=None,
        subagent_class="main",
        tool_call_id=tool_call_id,
    )


def mutated_paths(tool_input: dict[str, Any]) -> list[str]:
    """Every path a mutating call touches, incl. MultiEdit edit entries."""
    paths: list[str] = []
    for key in ("file_path", "notebook_path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            paths.append(value)
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for edit in edits:
            if isinstance(edit, dict):
                value = edit.get("file_path")
                if isinstance(value, str) and value and value not in paths:
                    paths.append(value)
    return paths


class CaptureManifestHandler:
    """Register the touch set whenever the plan file is written."""

    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PostToolUse)
        if not event.session_id or event.tool_name not in registry.MUTATING_TOOL_NAMES:
            return None
        plan_paths = [
            path
            for path in mutated_paths(event.tool_input)
            if manifest_store.matches_plan_glob(path, deps.settings.plan_glob)
        ]
        if not plan_paths:
            return None
        content = _written_content(event.tool_input)
        parsed = parse_files_to_touch(content)
        if not parsed.ok:
            manifest_store.deactivate(deps.store, event.session_id)
            return HookDecision.allow(
                f"BetterAI plan manifest warning: could not parse {plan_paths[0]} "
                f"({parsed.error}); the plan-scope gate is INACTIVE until the "
                "'## Files to touch' section parses."
            )
        return self._register(event, deps, parsed.entries)

    def _register(
        self, event: PostToolUse, deps: Deps, entries: tuple[ManifestEntry, ...]
    ) -> HookDecision:
        previous = manifest_store.entries(deps.store, event.session_id)
        if not previous:
            registered = [manifest_store.entry_to_dict(entry) for entry in entries]
            manifest_store.register(deps.store, event.session_id, registered)
            return HookDecision.allow(
                f"BetterAI plan manifest captured: {len(registered)} path(s) editable."
            )
        return self._extend(event, deps, entries, previous)

    def _extend(
        self,
        event: PostToolUse,
        deps: Deps,
        entries: tuple[ManifestEntry, ...],
        previous: list[dict],
    ) -> HookDecision:
        known = {manifest_store.normalize_path(item["path"]) for item in previous}
        new = [
            entry
            for entry in entries
            if manifest_store.normalize_path(entry.path) not in known
        ]
        warnings: list[str] = []
        merged = list(previous)
        for entry in new:
            if entry.justified:
                merged.append(manifest_store.entry_to_dict(entry))
                deps.audit.record(
                    "plan_manifest_extend",
                    {"gate": GATE_NAME, "path": entry.path, "functions": entry.functions},
                    _hook_meta(event.session_id, "hook.post_tool_use"),
                )
                warnings.append(
                    f"BetterAI plan manifest EXTENDED via justify: {entry.path} (audited)."
                )
            else:
                warnings.append(
                    f"BetterAI plan manifest warning: {entry.path} was added without a "
                    "justify: line and is NOT editable; add 'justify: <reason>' under it."
                )
        manifest_store.register(deps.store, event.session_id, merged)
        return HookDecision.allow("\n".join(warnings) if warnings else None)


class DenyOutsideManifestHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, PreToolUse)
        if not event.session_id or event.tool_name not in registry.MUTATING_TOOL_NAMES:
            return None
        if not manifest_store.is_active(deps.store, event.session_id):
            return None
        entries = manifest_store.entries(deps.store, event.session_id)
        for path in mutated_paths(event.tool_input):
            if manifest_store.path_allowed(entries, path, deps.settings.plan_glob):
                continue
            reason = str(Errors.edit_outside_manifest(path))
            deps.audit.record(
                "gate_denial",
                {
                    "gate": GATE_NAME,
                    "denied_tool": event.tool_name,
                    "denied_path": path,
                    "reason": reason,
                },
                _hook_meta(event.session_id, "hook.pre_tool_use"),
            )
            return HookDecision.block(reason, ERROR_CODE)
        return None


class ClearManifestHandler:
    def handle(self, event: HookEvent, deps: Deps) -> HookDecision | None:
        assert isinstance(event, SessionEnd)
        manifest_store.clear(deps.store, event.session_id)
        return None


def _written_content(tool_input: dict[str, Any]) -> str:
    """Write carries full content; Edit only carries new_string, so a
    partial re-parse is best effort — failure just deactivates loudly."""
    for key in ("content", "new_string"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return ""


HANDLERS = {
    PreToolUse: DenyOutsideManifestHandler(),
    PostToolUse: CaptureManifestHandler(),
    SessionEnd: ClearManifestHandler(),
}
