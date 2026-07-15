"""Eval harness (P8): two-arm A/B task evals with a blind LLM judge,
plus the install smoke. Driven by `betterai eval fixtures|run|install-smoke`.

Design per docs/EVAL-HARNESS.md: control (no BetterAI) vs treatment
(live harness) generate the same fixture task in isolated workdirs; a
blind judge scores both diffs 0/1/2 per rubric criterion; the outcome
metric is the treatment win rate. Fixtures must target rules a frontier
base model actually violates — generic hygiene does not differentiate.
"""
