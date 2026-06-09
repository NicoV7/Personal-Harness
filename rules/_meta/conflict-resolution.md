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

## Cross-scope conflicts (repo vs global)

The corpus has two roots: **global** (`~/.betterai/`) and **repo** (`<repo-root>/.betterai/`). The retrieval layer runs against both and merges results. Within-kind, scope is the tiebreaker at id-collision.

**The rule:** when the same `id` appears in both corpora, the **repo version replaces the global version** in the response. The global is dropped — the agent never sees it. The override is recorded in the audit log (`overridden_global_ids`) for diagnostics, but it does not appear in the agent's injected context.

Why this shape:

- A repo author saying "this rule is different *here*" is the literal use case. Re-declaring with the same id is the natural override gesture.
- Merging frontmatter or bodies across scopes would create a Frankenstein artifact that neither author can reason about. Replacement is unambiguous.
- The agent should not see two contradictory versions of the same id — that's just noise. The repo wins; the global is gone.
- Repo gets **no automatic ranking boost** for non-colliding ids. A global rule and a repo rule with distinct ids are ranked normally (severity × match-strength × recency); both appear in the response with a `scope` field tagging each one.

What this rule does *not* do:

- It does not merge bodies across scopes. The repo file is the whole truth for that id.
- It does not let the repo *delete* a global rule by some other mechanism — only same-id collision triggers the override.
- It does not apply across kinds. A repo *skill* with id `X` does not override a global *rule* with id `X` (different kinds, retrieved separately).

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
- Include the `scope` tag (`[GLOBAL]` or `[REPO]`) of each cited artifact so reviewers can tell at a glance whether the resolution depended on which corpus supplied it.
- If a `durability: long` decision-memory overrode a rule, recommend that the rule be edited or scoped.

**One thing the agent does NOT need to surface:** cross-scope id-collision overrides. When the repo version of a rule replaces the global version, the global is *dropped from the response entirely* — the agent never sees it, so there's no conflict to flag in the plan. The override is visible only in the audit log (`overridden_global_ids`). This is by design: the override is the intended behavior, not a tension to escalate. If you want to know whether a given retrieval involved an override, read the audit log or run `betterai status`.

This keeps the moat clean: rule-vs-rule and rule-vs-memory conflicts become editing signals; scope overrides become silent and diagnostic.

## What good looks like (worked examples)

### Example 1 — within-scope conflict: memory overrides rule

The agent is asked to refactor a webhook handler. Retrieval returns three artifacts (all global scope):

- `rule: webhook-idempotency-key-required` [GLOBAL] (severity: high, domain: idempotency)
- `rule: prefer-pure-functions` [GLOBAL] (severity: medium, domain: maintainability)
- `memory: webhook-replay-uses-redis-not-postgres` [GLOBAL] (kind: decision, durability: long)

The agent is mid-refactor and notices it could pull idempotency state from a Postgres table that already exists, which would let it keep the handler pure. The pure-function rule says yes; the long-durability decision-memory says no, replay state lives in Redis.

The agent's plan reads:

> Refactoring `webhooks/stripe.ts`. Retrieved guidance:
>
> - `webhook-idempotency-key-required` [GLOBAL] (rule, high): every handler must read `Stripe-Signature` and dedupe by event id.
> - `prefer-pure-functions` [GLOBAL] (rule, medium): extract side-effects.
> - `webhook-replay-uses-redis-not-postgres` [GLOBAL] (memory, decision/long): dedupe state lives in Redis.
>
> Conflict: `prefer-pure-functions` suggests sourcing dedupe state from the existing Postgres `webhook_events` table to keep the handler pure. The decision-memory overrides this — Redis is the canonical store. Per conflict-resolution: long-durability decision-memory > rule.
>
> Following the memory. Flagging `prefer-pure-functions` as a candidate for `applies_when.paths` exclusion of `webhooks/**`.

That's the shape: surface the conflict, cite the priority that resolved it, propose the corpus edit that would prevent the conflict from re-firing.

### Example 2 — cross-scope conflict: repo overrides global at id-collision

The user's global corpus contains `~/.betterai/rules/STANDARDS/naming/use-snake-case.md`:

```yaml
id: use-snake-case
title: Use snake_case for identifiers
category: STANDARDS
domain: naming
severity: medium
```

…with a body that says "use snake_case for variable, function, and file names — it's our house style."

The agent is now working in a React project that ships a repo corpus. The repo contains `<repo-root>/.betterai/rules/STANDARDS/naming/use-snake-case.md` (note: **same id**):

```yaml
id: use-snake-case
title: Use camelCase for identifiers in this React codebase
category: STANDARDS
domain: naming
severity: high
```

…with a body that says "this codebase follows React community convention: camelCase for variables and functions, PascalCase for components, kebab-case for filenames. The global snake_case rule does not apply here."

**Outcome for the agent in the React repo:**

- The retrieval pipeline detects the repo root, queries both corpora, and finds an id-collision on `use-snake-case`.
- The global version is dropped from the response. The agent receives only the repo version (`[REPO]`, severity: high, "use camelCase").
- The audit log records `overridden_global_ids: ["use-snake-case"]`.
- The agent's plan does **not** need to mention the override — there's no tension in its context, just the repo rule. (`betterai why` or `betterai status` would surface the override if the human wanted to see it.)

**Outcome for the agent in a non-React repo (no repo corpus, or repo corpus without that id):**

- The retrieval pipeline finds no collision. The agent receives only the global version (`[GLOBAL]`, severity: medium, "use snake_case").
- The audit log records `overridden_global_ids: []`.

That's the shape: a project says "the rule is different *here*" by re-declaring with the same id. The agent always gets the locally-correct answer for its repo, with no contradictory noise.
