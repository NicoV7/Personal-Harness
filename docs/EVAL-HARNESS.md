# BetterAI Eval Harness — Qualitative with-corpus vs without-corpus

**Status**: PROPOSED (designed during /autoplan post-mortem code review, 2026-06-09)
**Owner**: nicov
**Slots into v1.5 plan**: Item 5b (held-out regression pack) + Item 4 (dogfooding gate exit measurement)
**Related skill**: gstack-benchmark-models pattern; this is the BetterAI-specific variant.

---

## The question

> Does loading the BetterAI corpus actually make an agent produce better code?

Retrieval metrics (nDCG@5, precision@3) are internal. They don't answer this. The only answer that matters is: *given the same task, does the agent with BetterAI produce something that a human reviewer would call better than the agent without BetterAI?*

## The experiment

For each fixture in `src/__tests__/fixtures/task-evals/regression/`:

1. **Same prompt** dispatched to two parallel agents:
   - **Agent A (control)**: Claude Code, no BetterAI MCP registered.
   - **Agent B (treatment)**: Claude Code, BetterAI MCP registered + Stop hook installed.
2. **Isolated worktrees** so neither agent sees the other's diff.
3. **Same model, same temperature, same system prompt baseline** — the only difference is BetterAI's presence.
4. **Capture per run**:
   - Full diff against the worktree baseline.
   - Output artifact (HTML page, code module, whatever the fixture asks for).
   - For Agent B: `retrieve_context` calls, `applied_rule_ids` from `apply_compliance` events, `betterai replay --session <id>` JSON.
   - Wall-clock + token cost.

5. **Judge phase** (LLM-as-judge):
   - A judge model (recommend distinct from A/B — e.g. Codex if A/B were Sonnet) reads BOTH outputs blind (no "this one used the corpus" label).
   - Scores each output 0-10 against a fixture-specific rubric.
   - Picks a winner OR declares draw.
   - Writes a one-paragraph explanation.

6. **Aggregate**: across N fixtures, count B-wins / A-wins / draws. Outcome metric = B-win rate.

## The first fixture (user's proposal)

**Task**: "Build a marketing landing page for a coffee shop. Single HTML file. Hero, features section, call-to-action. Mobile-responsive. Use semantic HTML and accessible markup."

**Rubric (fixture-specific)**:
- Semantic HTML (header/main/section/footer used correctly)?
- Accessibility (alt text on images, ARIA where needed, color contrast called out)?
- Responsive design (viewport meta, mobile-first CSS)?
- Security (no inline scripts, no `eval`, no external CDN without integrity hash)?
- Maintainability (no inline styles, no magic numbers, CSS organized)?
- Performance awareness (image hints, lazy loading, no render-blocking)?

Each criterion: 0/1/2 (missing / partial / fully addressed). Total /12.

**Why this fixture works**: it's one prompt that touches multiple rules in the corpus (accessibility, security, maintainability, performance). It lets the judge see whether BetterAI's rules show up as observable behavior in the agent's output.

## CLI surface

```bash
betterai eval --fixture coffee-shop-landing-page
betterai eval --fixture-set held-out          # runs all 5 held-out cases
betterai eval --fixture coffee-shop-landing-page --judge-model haiku-4.5
betterai eval --report ~/.betterai/eval/runs/2026-06-09T17:30:00Z/
```

Output:
```
FIXTURE: coffee-shop-landing-page
  Agent A (no-corpus):  score 7/12  | tokens 4.2k | 47s
  Agent B (with-corpus): score 10/12 | tokens 5.1k | 52s
  Judge verdict: B wins (+3). Quote: "B used semantic <main>, included
    skip-to-content link, lazy-loaded images. A used <div class='main'>
    and missed accessibility markup entirely."
  Applied rules (B): semantic-html-default, alt-text-required, no-inline-styles
  Verified compliance: 3/3 (all cited rules had matching diff evidence)
```

## Fixture file format

```yaml
# src/__tests__/fixtures/task-evals/regression/coffee-shop-landing-page.yaml
id: coffee-shop-landing-page
held_out: true                    # one of the 5 reserved-from-Item-6 cases
task_description: |
  Build a marketing landing page for a coffee shop. Single HTML file.
  Hero, features, CTA. Mobile-responsive. Semantic + accessible.

# Rules the corpus SHOULD surface for this task (gold standard for judging
# "did B actually use the corpus" vs "did B just happen to produce similar output")
expected_rule_fires:
  - semantic-html-default
  - alt-text-required
  - no-inline-styles
  - viewport-meta-required

rubric:
  - id: semantic-html
    weight: 2
    criterion: "Uses <header>, <main>, <section>, <footer> with correct nesting"
  - id: accessibility
    weight: 2
    criterion: "Images have alt text; interactive elements have ARIA labels; skip-link present"
  # ...

expected_rubric_min: 8           # both agents should clear this; differential is the signal
```

## Execution mechanics

**Isolation**: each agent runs in its own worktree under `.claude/worktrees/eval-{fixture-id}-{a|b}/`. Worktrees auto-cleaned post-run.

**Determinism**: temperature 0 if the model supports it; fixed seed for any randomness; clear conversation between runs.

**Concurrency**: A and B run in parallel (no contention; different worktrees). Judge waits for both to complete.

**Storage**: one run directory under `~/.betterai/eval/runs/{timestamp}/` with:
```
runs/2026-06-09T17:30:00Z/
  fixture-id/
    a/
      input.md                  # exact prompt sent
      diff.patch                # what A produced
      artifact.html             # primary output
      transcript.jsonl          # full conversation
      cost.json                 # tokens, wall-clock
    b/
      input.md
      diff.patch
      artifact.html
      transcript.jsonl
      cost.json
      retrieval_path.jsonl      # B-only: retrieve_context audit trail
      apply_compliance.jsonl    # B-only: applied_rule_ids per event
    judge/
      rubric_a.json
      rubric_b.json
      verdict.md                # winner + reasoning
```

## Integration with v1.5 Items 5b + 6

- **Item 5b deliverable**: build the harness (this doc → code) + author the ~25-40 fixtures (5 held-out).
- **Item 6 deliverable**: after rule rewrites, re-run `betterai eval --fixture-set held-out`. The B-win-rate delta is the outcome metric.
- **Statistical posture**: with 5 held-out fixtures, the granularity is coarse (each fixture is a binary win/lose/draw). Don't claim a ≥30% relative lift. Claim "≥3 of 5 held-out fixtures flip from draw/A-win to B-win after rewrites" or similar absolute count.

## Honesty about the design

- **LLM judge bias**: judges trained on the same data may have systematic preferences. Mitigation: rotate judge model across runs; sample a small subset (~10%) for human spot-check; release judge prompts publicly so bias is auditable.
- **Cost**: each fixture run costs A-tokens + B-tokens + judge-tokens. For 5 held-out × 3 judges × 2 runs (pre/post Item 6) = 30 agent calls + 30 judge calls per measurement cycle. Acceptable for an outcome metric; not acceptable for continuous evaluation.
- **What it cannot measure**: long-term retention. Whether the user's *next* session benefits from a rule fired in *this* session. That's a longitudinal question this harness doesn't answer.
- **What it can measure**: differential behavior on a controlled task. That's enough for "does BetterAI move the needle" — the question Item 4 (dogfooding gate) and Item 6 (rule rewrites) ultimately need to answer.

## Open questions

1. **Judge model**: rotating Haiku-4.5 + Codex + Sonnet (different lineages) or pin one? Recommendation: pin Codex for v1.5 (different vendor lineage from primary agents), revisit at v1.6+.
2. **Fixture authorship**: user-authored vs LLM-generated then user-curated? Recommendation: user-curated. Use Item 4 (dogfooding gate) sessions as raw material; user picks 25-40 prompts that exposed real behavior differences.
3. **Cache invalidation**: when a rule rewrite changes `rule_body_hash`, re-run eval automatically? Recommendation: yes — `betterai eval --fixture-set held-out --since=last-rewrite`.

## Next concrete steps

1. Land Wave 5 (pre-flight Item 1). Eval harness needs working MCP + `report_rule_application`.
2. Write `src/cli/eval.ts` skeleton — wires worktree-per-agent + judge dispatch.
3. Author the coffee-shop fixture (one fixture is enough to exercise the harness end-to-end).
4. Wire to Item 5b regression pack as the harness reference implementation.

## TODO-post-wave-5: bearer.ts/context-hash.ts replay eval

A second reference fixture for the harness — uses the existing Wave-3 files as targets and the user's 8 manual code-review findings as the answer key.

**Authoritative design memo**: `/Users/nicov/.claude/plans/ok-well-that-may-serene-conway.md` (approved 2026-06-09).

**Slot in v1.5 design doc**: `/Users/nicov/.gstack/projects/betterai/nicov-main-design-20260609-170602.md` § "Post-Wave-5 Task — bearer.ts/context-hash.ts replay eval".

**Key differences from the coffee-shop fixture**:
- Targets are existing repo source files, not a fresh task. The eval question is "does the corpus catch known smells" not "does it produce better code."
- Has a **contamination problem**: the 3 corpus rules authored alongside the design quote target source verbatim. Decontamination of `## Anti-patterns` sections is required before any run.
- Has a **length-matched placebo arm** (A') to control for "more context primes more findings" — this should also propagate to the coffee-shop fixture and any future fixture as a standing methodology requirement.
- N=1 for first pass; N≥3 for any defensible claim (see plan file's failure mode #6).

**Dependency chain before running**:
1. Wave 5 contracts green
2. Item 1b `src/contracts/` extracted
3. Item 2 minimal tracing live
4. Item 2.5 `report_rule_application` MCP tool + Stop hook
5. Item 3 applied-rule contract shipped
6. `corpus_decontaminate` CLI helper built (Item 5b deliverable; see design memo)

**Skill-corpus improvements identified during this design** (track for Item 6):
- Widen `layered-architecture-default.md` `applies_when.intents` set
- Refactor the 3 new contaminated rules to use archetypal code samples instead of verbatim file-path/line-number quotes
- Ship `corpus_decontaminate` helper as a standing eval-harness tool
