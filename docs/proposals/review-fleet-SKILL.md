# Proposal: review-fleet skill (canonical copy)

If `~/.claude/skills/review-fleet/SKILL.md` is missing (the agent may be permission-blocked
from writing to `~/.claude/skills/*`), create it by copying the block below:

```bash
mkdir -p ~/.claude/skills/review-fleet
cp docs/proposals/review-fleet-SKILL.md /tmp/  # then extract the fenced SKILL.md below
```

The authoritative SKILL.md body is identical to what this session wrote to
`~/.claude/skills/review-fleet/SKILL.md`. If that write succeeded, this proposal is just a
version-controlled backup. The skill is a self-contained multi-agent workflow:

- **Phase A** parallel scanners (per-module + cross-cutting magic-numbers/DRY) tagging
  findings with a 9-dimension taxonomy (D1 correctness … D9 test-gaps).
- **Phase B** adversarial red-team (auth / fuzz / resource-exhaustion / data-integrity).
- **Phase B2** opt-in live DAST via Shannon (`npx @keygraph/shannon`) when `--target-url` is
  given — boots/points at a live app, runs real exploitation, parses the pentest report into
  the finding schema (`dimension: D4-security`, `live_exploited: true`). Fail-loud on missing
  prereqs (docker / node≥18 / Anthropic key); refuses non-owned targets without `--i-own-this-target`.
- **Phase C** organizer dedupes, adversarially verifies, groups into non-overlapping fix waves.
- **Phase D** auto-applies only high-confidence unambiguous fixes in green-gated worktree waves.

See `~/.claude/skills/review-fleet/SKILL.md` for the full executable instructions.
