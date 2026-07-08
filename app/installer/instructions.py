"""The agent-facing instructions block adapters write into client configs.

Kept in its own module because this text is a CONTRACT: the install-smoke
eval asserts the "For every user prompt" and "clean-code pass" strings
survive into generated AGENTS.md/instructions files. Edit deliberately.
"""

from __future__ import annotations

ALWAYS_CONSULT_INSTRUCTIONS = "\n".join(
    (
        "## BetterAI Harness",
        "",
        "For every user prompt, consult the BetterAI harness before planning,"
        " answering, or using ordinary tools.",
        "Call `query_skills` first with the prompt's intent; it retrieves the"
        " matching rules and skills and records the retrieval receipt the hard"
        " gates check. Then call `get_skill` for every returned artifact id"
        " before continuing -- read receipts are the deterministic proof the"
        " instructions were loaded, and the gates (retrieval receipt, plan"
        " manifest, incremental edit) keep mutating tools denied until they"
        " land.",
        "When editing code, run a clean-code pass before finishing: use"
        " inversion to reduce nesting, extract complex branches into clearly"
        " named functions, use understandable names, and prefer composition"
        " for shared behavior.",
        "If no skills match, continue normally. Do not copy bearer tokens or"
        " provider keys into config files.",
    )
)
