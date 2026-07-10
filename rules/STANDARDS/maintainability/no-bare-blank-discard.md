---
id: no-bare-blank-discard
title: Bind a descriptive name instead of discarding a return into a bare underscore
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-07-09
applies_when:
  paths: ["**/*.go", "**/*.ts", "**/*.py"]
  intents: ["naming", "error-handling", "readability"]
check:
  kind: regex
  pattern: "(^|[,(])\\s*_\\s*(,|:?=)"
related:
  - no-catch-all-exception-masking
  - no-redundant-internal-validation
source: PR Ambra911Software/backend#451 review
---

## What this rule says

When a call returns a value you don't currently use, bind it to a short,
descriptive name — do not throw it away into a bare `_`. A discard says
"nothing was here"; but something *was* here, and the only record of what it
was now lives in the callee's signature. The reader — human or AI agent — must
stop, open the callee, and read the return list to learn what the underscore
ate. That jump is pure cost, and it is avoidable: a bound name (`noStatusReason`,
`cacheHit`, `bytesWritten`) is the cheapest documentation that exists and it is
free at runtime. This is a code smell in *every* language, not a Go quirk.

The one genuinely fine case is a loop variable you truly never read: `for _, v
:= range xs` (Go), `for _ in range(3)` (Python). There the underscore *is* the
honest answer — there is no name to give an index nobody uses. This rule does
not ban `for _, v := range`. It bans discarding a *return value that carries
information*.

## Why it matters

A bound name is documentation that travels with the call site. A bare `_`
forces every future reader to reconstruct it by hand: a human pays a context
switch, and an AI agent pays worse — lacking the signature in context, it
*guesses* what was discarded, and a guess presented as fact is a hallucination.
The discard is also where errors go to die: a Go `_ = err` is the idiomatic
form of swallowing an error (see `no-catch-all-exception-masking`), assigning
the value that would have explained the failure to nothing.

## When this applies

- A multi-return call where you discard a return that carries a reason, a
  status, a count, or an error: `label, _, err := f()`, `val, _ := m[k]` where
  the `ok` decides real control flow, `_, err = f()` where the discarded
  sibling explains the error.
- `_ = x` on its own line — a discard wearing a name tag. It is the same smell,
  usually hiding an unchecked error or an unused-but-meaningful result.
- Any language: Go multi-returns, TS array/tuple destructuring (`const [, err]`),
  Python tuple unpacking (`_, reason = f()`).

Does NOT apply to a loop index you never read (`for _, v := range xs`,
`for _ in range(n)`), or a genuinely irrelevant return at a call whose sole
purpose is its side effect and whose signature makes that obvious.

Note the distinction from `no-redundant-internal-validation`: that rule concerns
a *leading* underscore as a privacy marker (`_name`) — naming a symbol you
*keep*. This rule concerns a *standalone* underscore that *discards* a value.
Different underscore, different concern; they do not overlap.

## When Go forces your hand

Go is the sharp case because the compiler *forces* a discard at a multi-return
call site: you cannot write `label := f()` when `f` returns three values.
Python never forces this — you simply don't unpack what you don't want. So Go
accretes underscores by compiler pressure, each silently deleting a return a
name would have surfaced.

The Go answer is **bind and use**, or **bind and assert** in a test (turn
`_, err := f()` into `got, err := f()` and add `require.Equal(t, want, got)`).
Never `_ = x` to quiet the compiler — that is the discard with a name tag.

## What good looks like

Bind the return, name it for what it *is*, and surface it:

```go
// The middle return explains why a denial produced no status. Name it, use it.
label, noStatusReason, err := CheckDenialClaimStatusViaStedi(denial.ID)
if err != nil {
    return err
}
resp := StatusResponse{Status: label}
if label == "unresolved" {
    resp.Reason = noStatusReason // "no DOB on file", "payer not resolved", ...
}
return c.JSON(resp)
```

The reason — "no DOB on file", "no active insurance", "payer not resolved" — is
now an API field instead of a value that never left the stack.

## Anti-patterns

The real case from `Ambra911Software/backend#451`. `CheckDenialClaimStatusViaStedi`
returns `(label, skip string, err error)`, and five call sites discarded the
middle value:

```go
// Wrong: the ONLY explanation of why the denial has no status is thrown away.
label, _, err := CheckDenialClaimStatusViaStedi(denial.ID)
if err != nil {
    return err
}
return c.JSON(StatusResponse{Status: label}) // {"status":"unresolved"} — no reason
```

The HTTP handler answered `{"status":"unresolved"}` with no explanation at all,
because the explanation was in the discarded `skip` return. Renaming `_` to
`noStatusReason` and surfacing it (see "What good looks like") turned a dead
value into a user-facing API field — no new data, just stopping the discard.

Sibling anti-pattern — the discard wearing a name tag, and the acceptable
contrast:

```go
_, err = persist(record) // Wrong: err's sibling (the saved row) is gone; often err itself goes unchecked next.

for _, v := range records { process(v) } // Fine: the index is genuinely unused; there is no name to give it.
```

## Examples

Cross-language: the underscore is a smell wherever a discarded return carried
information, and fine only where it truly did not.

```typescript
// BAD (TS): the error explaining the failure is destructured into a hole.
const [, err] = trySend(payload);
if (err) return; // what was `err`? and the first element — the receipt — is gone.

// GOOD: name both; the receipt and the reason are now readable at the call site.
const [receipt, sendError] = trySend(payload);
if (sendError) {
  logger.warn({ sendError }, "send failed");
  return;
}
recordReceipt(receipt);

// Python contrast — the acceptable throwaway vs the unacceptable discard:
// OK: the loop variable is genuinely unused.
//     for _ in range(3): retry()
// NOT OK: `reason` explains the rejection and is dropped.
//     _, reason = validate(claim)   # bind `reason`, then surface or log it
```
