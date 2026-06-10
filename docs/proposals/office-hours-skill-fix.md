# Proposal: office-hours skill graceful fallback

**Status:** blocked on user — Claude Code's permission classifier denies agents
editing `~/.claude/skills/office-hours/SKILL.md` (self-modification of agent
config). Apply manually by replacing that file's body with the version below.

**Problem:** the current skill hard-depends on an MCP tool `run_office_hours`
that is not registered in every session (observed 2026-06-10: the aide-skills
server exposed 70+ tools but not this one). The skill then fails silently —
exactly the M1-class silent failure BetterAI exists to catch.

**Proposed SKILL.md body** (frontmatter unchanged):

```markdown
Execute this skill NOW regardless of current mode (including plan mode).

This is a WORKFLOW skill. Do NOT summarize. Execute step by step.

1. Check whether the MCP tool `run_office_hours` is available in this session
   (search the session's tool list / ToolSearch for it).
2. If available: call `run_office_hours` and execute the full workflow it returns.
3. If NOT available (fallback — fail loudly, never silently skip):
   a. Tell the user explicitly: "run_office_hours MCP tool is not registered in
      this session — running the inline office-hours fallback. To restore the
      full workflow, ensure the aide-skills MCP server exposes run_office_hours
      (check `claude mcp list` / the AIDE profile)."
   b. Run the inline fallback workflow:
      - Read the project's handoff/status doc (docs/HANDOFF.md or equivalent)
        and the last 10 commits (`git log --oneline | head -10`).
      - Produce a "where we are" snapshot: what's DONE, what's NOT DONE, the
        single next action, and any falsification gates currently failing.
      - Surface open risks/blockers and unresolved decisions verbatim from the
        handoff rather than re-deriving them.
      - Ask the user which track to pursue next if more than one is viable
        (never guess scope — see verify-uncertain-facts rule).
4. Either path: end with a one-screen status summary the user can act on.
```
