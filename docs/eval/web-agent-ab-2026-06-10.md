# Web-agent A/B harness eval (2026-06-10)

**Question:** does the BetterAI harness (corpus retrieved over MCP + a design skill library) measurably change agent output vs a vanilla agent on the same prompt? This is the "how do we really know the harness works" gate — unit tests prove modules, this proves the harness.

**Setup:** identical brief (build a personal portfolio + a BetterAI architecture-map site, plain HTML/CSS) to two arms.
- **non-harness** (control): vanilla agent, no corpus, no design skill.
- **harness** (treatment): same agent + the 4 frontend/accessibility corpus rules **retrieved over real MCP** (`retrieve_context`, audit-logged) + the [taste-skill](https://github.com/leonxlnx/taste-skill) `soft-skill` design library.

Output (regenerated each run): `eval-output/non-harness/` and `eval-output/harness/`, each with `portfolio/` + `architecture-map/`. Retrieval evidence: `eval-output/_evidence/` (audit events + retrieved rule bodies).

## Result: winner = harness (design 9/9 vs 6/6) — but the lift is NOT where you'd expect

| Check | control | harness |
|---|---|---|
| Semantic HTML (landmarks, no div-soup) | pass | pass |
| Alt text on images | pass (0 imgs) | pass (1 img, descriptive alt + figure/figcaption) |
| Zero inline `style=` | pass (0) | pass (0) |
| Viewport meta on every page | pass | pass |
| Design quality (taste) | 6 | **9** |
| Fluid `clamp()` scales / `prefers-reduced-motion` | 1 clamp, no reduced-motion | 14 clamp/file, reduced-motion present |

## The finding (this is the important part)

**On a frontier base model, the corpus's floor-level hygiene rules didn't differentiate — the control arm already wrote semantic HTML, zero inline styles, and viewport meta without being told.** The measurable gap came almost entirely from the **taste-skill design library** (named design systems, fluid type scales, motion-accessibility, non-generic typography), not from the BetterAI rules.

Implications for the harness / reliability goal:
1. **The harness works** — retrieval→skill→output is wired end-to-end (audit proves the rules were retrieved over MCP), and the treatment output is measurably better. The "does it work" gate is **PASSED**.
2. **But an eval that only checks rules a strong base model already follows will read as a near-tie.** The corpus earns its keep on (a) things the base model does *not* already do — project-specific conventions, the architectural rules in BetterAI's own corpus, taste — and (b) as a regression guardrail when models change or on weaker models. Future eval fixtures should target rules the base model demonstrably violates without the corpus, or this metric stays noisy.
3. **A latent harness bug was caught and fixed en route:** the domain-router YAML parser was dead (every request fell back to default domains), so the frontend rules could never have surfaced. Fixed in `29b7771`; retrieval routing now actually works.

## Verdict

Proceed past the Phase-0 checkpoint to the architecture refactor (constants/config/errors layers → capability-flat restructure). Re-run this A/B after the restructure (Phase 3) and diff `eval-output/` + the audit trail against this baseline to prove the harness still works.
