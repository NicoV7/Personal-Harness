"""Single registration point for the MCP tool surface and hook chains.

FROZEN CONTRACT for the parallel build: tool and gate modules implement
the shapes this file imports; nobody edits this file during the build.

Tool module contract (app/mcp/<tool>/):
  schema.py   exposes `INPUT_MODEL` (pydantic BaseModel subclass)
  handler.py  exposes `NAME: str`, `DESCRIPTION: str`, and
              `async def handle(input: INPUT_MODEL, deps: Deps, meta: CallMeta,
                                on_progress: ProgressFn | None = None) -> dict`

Gate module contract (app/mcp/<gate>/):
  gate.py     exposes `HANDLERS: dict[type, HookHandler]` mapping event
              types to module-level handler instances

`Deps` is the shared dependency container built in app/server.py (see
app/deps.py): settings · audit · corpus · pipeline · store. Per-call
progress is NOT a Deps member — it is the `on_progress` argument.
"""

from __future__ import annotations

from app.hooks.chain import HookChain
from app.hooks.events import PostToolUse, PreToolUse, SessionEnd, Stop, UserPromptSubmit

# Tools, alphabetical. The surface is exactly these nine.
TOOL_MODULES = (
    "app.mcp.add_skill",
    "app.mcp.configure_skill",
    "app.mcp.edit_skill",
    "app.mcp.format_plan_skills",
    "app.mcp.get_plan_skills",
    "app.mcp.get_skill",
    "app.mcp.list_skills",
    "app.mcp.query_skills",
    "app.mcp.start_container",
)

# Bootstrap tools are always allowed through PreToolUse gates so an agent
# can satisfy the gates. Matching is substring-based to cover client
# prefixes like `mcp__betterai__query_skills`. NOTE: "get_skill" does NOT
# substring-match get_plan_skills — both plan tools need their own entry.
BOOTSTRAP_TOOL_FRAGMENTS = (
    "query_skills",
    "get_skill",
    "get_plan_skills",
    "format_plan_skills",
    "list_skills",
    "start_container",
)

# Mutating client tools the receipt/manifest/budget gates apply to.
MUTATING_TOOL_NAMES = ("Edit", "Write", "MultiEdit", "NotebookEdit")

# Turn-scoped SessionStore namespaces, cleared on every UserPromptSubmit.
TURN_NAMESPACES = ("read_gate", "retrieval_receipt", "edit_budget", "stop_state")

# PreToolUse gate order: first deny wins.
GATE_MODULES = (
    "app.mcp.read_gate",
    "app.mcp.retrieval_receipt_gate",
    "app.mcp.plan_manifest_gate",
    "app.mcp.edit_budget_gate",
)


def build_chain() -> HookChain:
    """Compose the hook pipeline. Import here (not at module top) so the
    registry stays importable while gate modules are being built."""
    from importlib import import_module

    chain = HookChain()
    for module_path in GATE_MODULES:
        gate = import_module(f"{module_path}.gate")
        for event_type in (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd):
            handler = gate.HANDLERS.get(event_type)
            if handler is not None:
                chain.register(event_type, handler)
    return chain


def tool_modules() -> tuple[tuple[object, object], ...]:
    """Yield (schema_module, handler_module) per tool, alphabetical."""
    from importlib import import_module

    loaded = []
    for module_path in TOOL_MODULES:
        schema = import_module(f"{module_path}.schema")
        handler = import_module(f"{module_path}.handler")
        loaded.append((schema, handler))
    return tuple(loaded)
