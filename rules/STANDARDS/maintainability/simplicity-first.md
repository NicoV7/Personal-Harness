---
id: simplicity-first
title: Simplicity first — write the minimum code that solves the problem
category: STANDARDS
domain: maintainability
severity: high
created: 2026-06-09
applies_when:
  paths:
    - "**/*.ts"
    - "**/*.py"
  intents:
    - plan
    - implement
    - refactor
related:
  - surgical-changes
  - think-before-coding
---

## What this rule says

Write the minimum code that solves the problem the user actually asked for. No
speculative features, no abstractions for single-use code, no "flexibility" or
"configurability" that wasn't requested, and no error handling for impossible
scenarios.

The test: if you wrote 200 lines and it could plausibly have been 50, rewrite
it. If a senior engineer reading it would say "this is overcomplicated," it is.

## Why it matters

Premature complexity has compounding costs. Strategy patterns, configuration
flags, and pluggable backends added "in case we need them later" make the code
harder to read, harder to test, more bug-prone, and slower to ship. The
overhead is paid every time someone reads the file for the rest of the project's
life — including by the agent itself on the next pass.

In a personal-toolkit codebase like this one, YAGNI is the default. If a
requirement actually emerges later, refactor *then*. Refactoring from a simple
working implementation is cheap; refactoring from a wrong abstraction is
expensive.

## When this applies

- Planning a new feature: prefer the shortest path that satisfies the stated
  acceptance criteria.
- Implementing a function: prefer one concrete function over a hierarchy of
  classes with a single concrete subclass.
- Refactoring: only abstract when there are two or more real callers with
  diverging needs — not one caller and an imagined future one.
- Reviewing AI-generated code: if it introduced ABCs, registries, strategy
  objects, or a `*Manager` class for a single-use code path, demand
  justification or revert.

Does NOT apply when the requirement explicitly calls for the abstraction
(e.g., "build a plugin system"), or when an external interface contract
mandates a particular shape.

## What good looks like

A discount calculation asked for in one place is one function. No strategy
hierarchy, no config object, no `DiscountCalculator` class wrapping a single
arithmetic expression:

```ts
// Good: one function, one job, callable in one line.
export function calculateDiscount(amount: number, percent: number): number {
  return amount * (percent / 100);
}

// Caller:
const off = calculateDiscount(100, 10); // 10
```

Saving user preferences is one query, not a `PreferenceManager` with optional
caching, validation, merging, and notification hooks that nobody asked for:

```ts
export async function saveUserPreferences(
  db: Database,
  userId: number,
  prefs: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    "UPDATE users SET preferences = ? WHERE id = ?",
    [JSON.stringify(prefs), userId],
  );
}
```

## Anti-patterns

The discount-calculator anti-pattern: introducing `DiscountStrategy` (abstract
base), `PercentageDiscount`, `FixedDiscount`, a `DiscountConfig` dataclass, and
a `DiscountCalculator` orchestrator — 30+ lines of setup for a single
multiplication. Nothing in the request implied multiple discount types.

```ts
// Anti-pattern: every line is dead weight until a second discount type exists.
interface DiscountStrategy { calculate(amount: number): number; }
class PercentageDiscount implements DiscountStrategy { /* ... */ }
class DiscountCalculator {
  constructor(private cfg: { strategy: DiscountStrategy; min: number; max: number }) {}
  apply(amount: number) { /* ... */ }
}
```

Fix: collapse to the single function above. When a second discount type
actually appears, *then* extract — you'll know the right seam because you have
two real cases to compare.

The save-preferences anti-pattern: `PreferenceManager` with `merge`,
`validate`, `notify` flags and an injected cache. Each flag is a feature the
user did not ask for, each one is a code path that must be tested and
maintained, and the "off by default" ones almost always rot.

## Examples

A useful heuristic for catching this in review: count the constructor
parameters, optional flags, and abstract base classes a change introduces.
If that count is greater than zero and the user request was a single concrete
verb ("calculate," "save," "fetch," "format"), the change is almost certainly
overengineered. Push back, or rewrite to a single function before merging.
