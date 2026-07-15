"""get_skill — full markdown body by id, recording the read receipt.

Any-kind lookup (rules and skills share the artifact namespace) because
this tool replaces both read_skill and explain_rule from the TS surface.
The receipt bookkeeping moves the id from the read-gate `required` set
to the `read` set — that transition is what PreToolUse gates check
before allowing mutating tools.
"""

from __future__ import annotations

from app.deps import CallMeta, Deps, ProgressFn
from app.errors import Errors
from app.mcp.get_skill.schema import GetSkillInput

NAME = "get_skill"
DESCRIPTION = (
    "Return the full markdown body of a corpus artifact (skill or rule) by id "
    "and record the read receipt. Call this for EVERY skill query_skills "
    "returns before planning or using mutating tools — read receipts are the "
    "deterministic proof the harness instructions were loaded."
)


async def handle(
    input: GetSkillInput,
    deps: Deps,
    meta: CallMeta,
    on_progress: ProgressFn | None = None,
) -> dict:
    artifact = deps.corpus.find(input.skill_id)
    if artifact is None:
        raise Errors.artifact_not_found(input.skill_id)
    _record_read_receipt(deps, meta, artifact.id)
    deps.audit.record(
        "skill_read",
        {"id": artifact.id, "artifact_type": artifact.artifact_type, "scope": artifact.scope},
        meta,
    )
    return artifact.model_dump(exclude_none=True)


def _record_read_receipt(deps: Deps, meta: CallMeta, artifact_id: str) -> None:
    # Advisory for hook gates: MCP and hook session ids differ; the prompt
    # hook marks reads at delivery under the id the gates actually check.
    session_id = meta.agent_session_id
    if session_id is None:
        return
    required = deps.store.get(session_id, "read_gate", "required") or []
    deps.store.set(
        session_id,
        "read_gate",
        "required",
        [item for item in required if item != artifact_id],
    )
    read = deps.store.get(session_id, "read_gate", "read") or []
    if artifact_id not in read:
        deps.store.set(session_id, "read_gate", "read", [*read, artifact_id])
