# Task-eval regression fixtures

Fixtures for the EVAL-HARNESS A/B (control: no corpus · treatment: BetterAI corpus over MCP).
Format per [`docs/EVAL-HARNESS.md`](../../../../../docs/EVAL-HARNESS.md).

## Selection principle: base-model-violating

The 2026-06-10 web-agent A/B ([`docs/eval/web-agent-ab-2026-06-10.md`](../../../../../docs/eval/web-agent-ab-2026-06-10.md))
showed that **generic hygiene rules a frontier base model already follows produce ~0 measurable corpus lift**
— both arms wrote semantic HTML, alt text, zero inline styles, viewport meta unprompted. An eval built on
those rules reads as a tie and makes the corpus look worthless.

So fixtures here deliberately target **rules a strong base model VIOLATES without the corpus** — almost all of
them BetterAI's own project-specific conventions (`.betterai/rules/STANDARDS/`): bearer-on-every-tool,
parent-session in every audit event, HTTP/SSE-only transport, config-from-env, named constants, typed errors.
A vanilla agent cannot know these; the corpus is the only way it learns them. The differential (treatment −
control) is the real corpus-value signal.

Each fixture sets `expected_rubric_min` to roughly where the **control** arm is expected to land, so the lift
is the gap *above* that floor — not an absolute score that a competent base model clears anyway.

| Fixture | Targets | Why base model fails it |
|---|---|---|
| `add-mcp-tool` | mcp-tools-require-bearer, audit-must-include-parent-session, no-stdio-mcp-transport, typed-errors | defaults to generic MCP SDK patterns; doesn't know BetterAI's invariants |
| `add-tunable-timeout` | config-from-env-not-hardcoded, no-magic-numbers, typed-errors | hardcodes the number at the call site by reflex |
| `negative-no-rule-applies` | (empty set) | guards the opposite failure — corpus over-firing on irrelevant work |

## Not yet built

The runner (`betterai eval --fixture <id>`, two-arm dispatch + LLM judge) is the EVAL-HARNESS Item 5b
follow-on. These fixtures are the data it will consume; the 2026-06-10 A/B was run by an ad-hoc Workflow
(see `eval-output/`). Wiring the CLI runner to read this directory is the next eval step.
