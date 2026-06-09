---
id: ask-about-non-functionals
title: Ask about scalability, maintainability, and reliability before designing
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-06-09
applies_when:
  intents:
    - plan
    - design
related:
  - think-before-coding
  - simplicity-first
  - no-god-files
---

## What this rule says

Before proposing or committing to an architecture, surface the three
non-functional dimensions that quietly drive every design decision and ask
about them explicitly:

1. **Scalability** — what's the expected load now and in 12 months? Single
   user, single machine? Multi-tenant? Per-second request volume?
2. **Maintainability** — who owns this code six months from now? Is this
   throwaway, evolving, or load-bearing infrastructure?
3. **Reliability** — what does failure look like? Is best-effort acceptable,
   or does this need durability guarantees, retries, idempotency?

When designing layered architecture, the default layering for a service is:
`services / models / dtos / tests / tools / constants / handlers`. Pick this
layering up front unless the request explicitly calls for something else.

Although this rule conceptually overlaps with PROCESS rules ("think before
coding"), it lives under STANDARDS/maintainability because the *consequence*
of skipping these questions is always a maintainability hit — over-engineered
or under-engineered systems both rot fastest.

## Why it matters

Non-functional requirements determine the *shape* of the solution, not just
its size. Asking after you've designed forces a rewrite; asking before takes
60 seconds and aligns the entire implementation.

Concrete failure modes from skipping this step:

- Building an in-memory cache for a feature that needs cross-instance
  consistency → rewrite at v2.
- Picking SQLite for a service that needs concurrent writers → migration
  pain at v3.
- Skipping idempotency for a webhook handler → duplicate-charge incident at
  v4.
- Adding multi-region replication for a personal toolkit → six weeks of
  yak-shaving for no user benefit.

The correct answer to a non-functional question is often "we don't need
that" — but you can only know that if you asked.

## When this applies

- Starting a new feature or service: ask before writing the design doc.
- Picking a storage backend, queue, cache, or coordination primitive: ask
  before committing.
- Designing an API surface that other code/agents will depend on: ask about
  versioning and stability expectations.
- Estimating effort: the answer changes the estimate by an order of
  magnitude.

Does NOT apply to: trivial bug fixes, isolated refactors inside a single
file, or one-off scripts with no callers.

## What good looks like

Before designing a "save user preferences" feature, ask three short
questions and proceed with the simplest answer:

```text
Quick scope check before I design this:

1. Scalability: how many users / writes-per-second are we sizing for?
   (Single user? <10/s? >1000/s?)

2. Maintainability: is this a throwaway prototype, or load-bearing for
   future features?

3. Reliability: if a save fails, is "show error and retry on next click"
   acceptable, or do we need durable queueing + retry?

My default if all three are 'small/throwaway/best-effort': one async
function writing to the existing SQLite DB. ~20 lines. Confirm?
```

The layered shape for the resulting service:

```
src/preferences/
  models/         // domain types
  dtos/           // wire/transport shapes
  services/       // business logic
  handlers/       // HTTP/MCP entry points
  tools/          // CLI or maintenance utilities
  constants/      // magic numbers, default prefs
  tests/          // co-located tests
```

This shape stays stable across maintainability levels — it's the *contents*
of each folder that scale with the answers.

## Anti-patterns

Diving into implementation without asking:

```ts
// Anti-pattern: 200 lines of code committed before the design conversation.
// Turns out the user needed cross-region durable writes, but this is
// in-memory only. Full rewrite.
class PreferencesCache {
  private store = new Map<number, Record<string, unknown>>();
  set(userId: number, prefs: Record<string, unknown>) { /* ... */ }
}
```

The reverse anti-pattern is asking *too many* questions and stalling.
Three focused questions, not twenty. If the user answers "I don't know
yet," default to the smallest reasonable design, name the assumption in
writing, and proceed.

Another anti-pattern: asking the questions but ignoring the answers. If
the user says "single user, throwaway," do not propose a Kubernetes
deployment. Calibrate the design to the answer.

## Examples

A useful three-question template you can paste verbatim at the start of any
design conversation:

> Before I design this, three quick calibration questions:
>
> 1. **Scale:** rough order of magnitude for load — 1 user, 100, 10k+?
> 2. **Maintenance horizon:** throwaway, evolving feature, or core infra?
> 3. **Failure mode:** what happens (and what's acceptable) when this
>    breaks?
>
> My default if you say "small / evolving / best-effort" is `<X>`. Override?

This converts a vague request into a calibrated design proposal in one round
trip, which is the cheapest possible alignment cost.
