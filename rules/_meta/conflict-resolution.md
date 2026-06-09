# Conflict Resolution

The BetterAI corpus injects three artifact kinds — rules, skills, memories — into an agent's context. The retrieval layer does not pre-filter for "consistency": it pulls whatever is relevant. That means agents will sometimes see artifacts that *disagree* about what to do. This document explains how the agent should resolve those disagreements, and how the corpus should *present* them.

This is the authoritative spec; if any individual artifact contradicts what's written here, this doc wins.

## Priority order (artifact-kind level)

When two retrieved artifacts give conflicting guidance on the same decision, the agent applies this precedence, top wins:

1. **Memory with `kind: decision` and `durability: long`** — these are settled architectural calls. We made them with full context once; we don't re-debate them on every retrieval.
2. **Rule** — the codified constraint. Rules are the moat; they outrank skills because rules say "don't" while skills say "how", and a "don't" trumps a "here's how" by construction.
3. **Skill** — the procedural how-to. If a skill's steps would violate a rule, the rule wins and the skill is wrong (or out of date).
4. **Memory with any other shape** — `kind: failure`, `kind: discovery`, `kind: constraint`, or `durability: short|medium`. These are informative but not binding; they color the decision rather than determine it.

Concretely: if a long-durability decision-memory says "we use Postgres, never SQLite," and a `database/` rule says "prefer SQLite for small services," the memory wins. The rule is *stale relative to the decision* and should be rewritten or scoped.

## Rule-vs-rule conflicts: Surgical > Simplicity, and why

The most common rule-vs-rule collision is between **Surgical Changes** (match the existing code's style and shape; minimize blast radius) and **Simplicity** (prefer the simpler expression locally).

These genuinely conflict on refactors: the existing code may use a verbose pattern that a clean-slate rewrite would simplify. The agent's instinct is often to "fix it on the way through."

**Surgical Changes wins.** Reasoning:

- The agent is editing inside a working system. Existing-code style is a *load-bearing* signal: reviewers scan for it, neighboring files mirror it, tooling may depend on it.
- "Simpler" is a local optimum that creates a global cost (inconsistency, larger diff, harder review, harder revert).
- The right time to simplify a pattern is a dedicated refactor PR with its own justification, not a drive-by during unrelated work.

The agent should still *name* the tension in its plan ("I would simplify X here, but per Surgical Changes I'm leaving it") so the human reviewer can decide to schedule the cleanup separately.

For any other rule-vs-rule collision, the agent picks the rule with the higher `severity` field. Ties go to the rule with the more specific `applies_when` match (a path-glob match beats an unmatched fallback).

## Memory-vs-rule conflicts: long-durability decisions trump rules

A rule encodes "what we generally believe." A long-durability decision-memory encodes "what we specifically decided for *this* project, knowing all the tradeoffs."

When they conflict, the memory wins because:

- The memory captures *this project's* context. The rule is corpus-wide.
- A `durability: long` flag is an explicit assertion that "this is settled — don't re-derive it."
- The corpus is supposed to *converge* over time; persistent rule-vs-memory conflicts are a signal that the rule should be edited (narrow its `applies_when`, or supersede it).

When the agent sees this kind of conflict, it should follow the memory **and** flag the conflict in its plan so the human can update the rule.

Short- and medium-durability memories do **not** win against rules. They get cited as additional context, not as overrides.

## How the agent should present conflicts in context

When the retrieval layer returns conflicting artifacts, the agent's plan output must surface the conflict, not hide it. Concretely:

- Name both artifacts by id.
- State which one is winning, and which rule from this doc made that call.
- If a `durability: long` decision-memory overrode a rule, recommend that the rule be edited or scoped.

This keeps the moat clean: conflicts become an editing signal rather than a silent override that no one notices.

## What good looks like (worked example)

The agent is asked to refactor a webhook handler. Retrieval returns three artifacts:

- `rule: webhook-idempotency-key-required` (severity: high, domain: idempotency)
- `rule: prefer-pure-functions` (severity: medium, domain: maintainability)
- `memory: webhook-replay-uses-redis-not-postgres` (kind: decision, durability: long)

The agent is mid-refactor and notices it could pull idempotency state from a Postgres table that already exists, which would let it keep the handler pure. The pure-function rule says yes; the long-durability decision-memory says no, replay state lives in Redis.

The agent's plan reads:

> Refactoring `webhooks/stripe.ts`. Retrieved guidance:
>
> - `webhook-idempotency-key-required` (rule, high): every handler must read `Stripe-Signature` and dedupe by event id.
> - `prefer-pure-functions` (rule, medium): extract side-effects.
> - `webhook-replay-uses-redis-not-postgres` (memory, decision/long): dedupe state lives in Redis.
>
> Conflict: `prefer-pure-functions` suggests sourcing dedupe state from the existing Postgres `webhook_events` table to keep the handler pure. The decision-memory overrides this — Redis is the canonical store. Per conflict-resolution: long-durability decision-memory > rule.
>
> Following the memory. Flagging `prefer-pure-functions` as a candidate for `applies_when.paths` exclusion of `webhooks/**`.

That's the shape: surface the conflict, cite the priority that resolved it, propose the corpus edit that would prevent the conflict from re-firing.
