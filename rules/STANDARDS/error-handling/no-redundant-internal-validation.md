---
id: no-redundant-internal-validation
title: Don't re-check types and nulls inside private/internal functions
category: STANDARDS
domain: error-handling
severity: medium
created: 2026-06-09
applies_when:
  paths: ["**/*.ts", "**/*.js", "**/*.py"]
  intents: ["defensive-programming", "type-narrowing", "internal-helper"]
related:
  - no-catch-all-exception-masking
  - no-defensive-optional-chains
source: RULES.md §4.3
---

## What this rule says

Private/internal helpers — functions that are not exported from a module boundary and whose callers are all within your control — should trust their declared parameter types. Do not add `if (x === undefined)`, `if (typeof x !== "number")`, `isinstance` checks, or runtime type guards inside helpers whose inputs are already validated by:

- The TypeScript compiler (for typed callers),
- A schema parser at the boundary (Zod, pydantic, etc.),
- The public API of the module (which is the right place to validate).

Validate at the boundary. Trust within the boundary. If the helper crashes loudly because someone passed the wrong type, that crash is a *gift* — it points at a real bug in the caller, not at the helper.

## Why it matters

Redundant internal validation has three costs:

- **Code bloat hides the algorithm.** A three-line bonus calculation gets buried under ten lines of type-checking. Readers spend their attention on the defense, not the math.
- **It lies about what the function does.** A signature `_calculate_internal_bonus(salary: float) -> float` that secretly returns `0` for non-floats is no longer a calculator — it is a "calculator that silently produces zero for bad data". Now every caller has to know about this fallback. The contract leaks.
- **It converts type bugs into data bugs.** A caller that accidentally passes `None` should crash *at the call site* during dev. Instead, it gets `0`, the result flows into payroll, and you find out in the next quarterly audit.

This rule is the inverse of validation at the boundary: validation only works as a discipline if internal code actually trusts it.

`severity: medium` — the failures are usually caught in dev, but when they slip through they masquerade as legitimate domain values (`0` salary, empty list, `None` user), which is hard to debug.

## When this applies

Applies when ALL of:

- The function is private (prefixed `_`, not exported, file-local), AND
- The function has typed parameters (TS types, Python annotations), AND
- The check is structural (`typeof`, `isinstance`, `=== null`, `=== undefined`) not semantic (range, business rule), AND
- A reachable caller has already validated the input (boundary parse, public-API guard, compiler).

Does NOT apply when:

- The function is the boundary (exported from the package, called by untrusted code, an HTTP handler), OR
- The check is a *semantic* invariant the type system can't express (`salary >= 0`, `id is a UUID`, `array is non-empty`), OR
- The language is fully dynamic (plain JS, untyped Python) and you have no schema validator either — in which case fix that first.

## What good looks like

Helpers carry a type-checked signature and read inputs directly. The boundary owns validation; helpers own logic.

```typescript
// Boundary: this is where the input is validated. Once.
const PayrollInputSchema = z.object({
  salary: z.number().nonnegative(),
  yearsOfService: z.number().int().nonnegative(),
});

export function computeAnnualBonus(rawInput: unknown): number {
  const input = PayrollInputSchema.parse(rawInput); // crashes loudly here on bad data
  return calculateInternalBonus(input.salary);
}

// Internal helper: trusts the type. No re-checking. Reads as a formula.
function calculateInternalBonus(salary: number): number {
  return salary * 0.10;
}
```

If a helper genuinely has a semantic invariant the type system can't express, assert it loudly (don't fall back):

```typescript
function calculateInternalBonus(salary: number): number {
  // Semantic invariant, not a structural one. Crash loudly.
  if (salary < 0) throw new Error(`salary must be non-negative, got ${salary}`);
  return salary * 0.10;
}
```

## Anti-patterns

The original example from `RULES.md §4.3` (Python):

```python
def _calculate_internal_bonus(salary):
    # Redundant checks inside a private helper where data control is internal
    if salary is None:
        return 0
    if not isinstance(salary, (int, float)):
        return 0
    return salary * 0.10
```

What goes wrong:

1. The leading underscore says "private — callers are inside this module". Those callers already know what `salary` is.
2. Both fallbacks return `0`, which is a *valid bonus*. Now `0` means "no bonus" AND "you passed garbage". Same value, two meanings.
3. The signature implies it accepts any input. Callers won't think to check.
4. When the real bug appears — a caller that constructs `salary` from a broken upstream — payroll silently zeroes out and the upstream bug ships.

The fix is to declare the type, drop the checks, and let the function crash on real bugs:

```python
def _calculate_internal_bonus(salary: float) -> float:
    return salary * 0.10
```

And validate at the entry point of the module:

```python
def compute_annual_bonus(raw: dict) -> float:
    parsed = PayrollInput.model_validate(raw)  # pydantic, crashes loudly here
    return _calculate_internal_bonus(parsed.salary)
```

## Examples

TypeScript before/after for a typical internal helper:

```typescript
// BAD — redundant defense on a private function.
function _normalizeTags(tags: string[]): string[] {
  if (tags === null || tags === undefined) return [];
  if (!Array.isArray(tags)) return [];
  return tags.map(t => {
    if (typeof t !== "string") return "";
    return t.toLowerCase().trim();
  }).filter(Boolean);
}

// GOOD — the type is the contract. The function does one thing.
function normalizeTags(tags: string[]): string[] {
  return tags.map(t => t.toLowerCase().trim()).filter(Boolean);
}
```

The good version is half the size, has the same type signature, and surfaces real bugs (a caller passing `undefined`) at the crash site instead of silently producing `[]`. If the function ever becomes part of a public API, *that* is when you add a Zod parser at the new boundary — not when you sprinkle `typeof` checks through internals.
