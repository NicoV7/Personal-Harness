---
id: goal-driven-execution
title: Define verifiable success criteria, then loop until verified
category: PROCESS
domain: methodology
severity: medium
created: 2026-06-09
applies_when:
  intents: [plan, implement, test]
related: [think-before-coding, search-context-before-substantive]
source: RULES.md rule 4
---

## What this rule says

Translate every task into a goal with a concrete pass/fail verification step before starting work. The verification step must be executable — a test that runs, a command that returns a status, a manual check with a defined expected outcome. For multi-step tasks, state the steps up front and attach a verification to each one. Then loop: run the work, run the verification, if it passes proceed; if it fails, fix and re-verify. The loop terminates when verification passes, not when the agent "feels done."

Strong verification criteria let the agent self-correct without round-tripping with the user for clarification. Weak criteria — "make it work," "fix the bug," "improve the code" — leave the agent unable to tell when it is done, which produces either premature handoff (declaring victory while the bug persists) or unending elaboration (refactoring well past the point of value).

## Why it matters

Without an executable verification, the loop has no terminator. The agent either stops too early (the change compiles, so it must be correct) or too late (one more refactor, one more abstraction, until the diff balloons). Both failures are expensive: the early stop ships a regression; the late stop wastes time and triggers a rejection on review.

A defined verification also forces the right work order. "Write a test that reproduces the bug, then fix it" guarantees the fix actually addresses the reported behavior. "Just fix the bug" lets the agent change code that looks suspicious, declare victory, and miss the actual cause entirely. The verification IS the spec.

## When this applies

- The user describes a bug or feature in informal terms ("the search is slow," "fix the auth"). Translate to a verifiable goal before coding.
- A task has more than one step. Attach verification to each step so partial progress is auditable.
- The change touches behavior that has user-observable effects. The verification is "what does the user see after the change?"
- A refactor is requested. The verification is "the existing test suite continues to pass" — that's the entire point of the refactor having no behavioral change.

It does NOT apply to pure exploration ("show me how this module works") or to formatting-only changes where there's no behavior to verify.

## What good looks like

A goal-driven plan names the goal, names the verification, then names the steps. Each step has its own verification. The plan is auditable in advance.

```typescript
// User: "Add rate limiting to the API"
// Translate to verifiable plan:

const plan = {
  goal: "API rejects more than 10 requests per minute per IP on /search",
  verification: "100 sequential curl requests: first 10 return 200, rest return 429",
  steps: [
    {
      step: "Add in-memory rate-limit middleware to /search route",
      verify: "unit test: 11th request in the same minute returns 429",
    },
    {
      step: "Extract middleware so it can be applied to other routes",
      verify: "existing /search test still passes; new /posts test also passes",
    },
    {
      step: "Add per-route configuration (rate, window)",
      verify: "config-driven test: /search=10/min, /posts=100/min both enforced",
    },
  ],
};

// The agent runs step 1, runs its verification, only then starts step 2.
```

The test-first pattern is the canonical form for bug fixes:

```typescript
// User: "Sorting breaks when scores are duplicated"

// Step 1 (write failing test):
test("sort_scores is stable for duplicate scores", () => {
  const input = [
    { name: "Alice", score: 100 },
    { name: "Bob", score: 100 },
    { name: "Charlie", score: 90 },
  ];
  const result = sortScores(input);
  expect(result.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
});
// Verify: test FAILS — bug is reproduced.

// Step 2 (implement fix): tie-break on name.
function sortScores(scores: Score[]) {
  return [...scores].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
// Verify: test PASSES.

// Step 3: full suite still green.
```

## Anti-patterns

**Wrong:** Vague plan, no verification.

```typescript
// User: "Fix the authentication system"
// Agent: "I'll review the code, identify issues, make improvements, and test."
// Agent then changes 12 files across auth, sessions, and middleware.
// No definition of what "fixed" means. No way to tell if any of the changes
// addressed the user's actual problem.
```

**Fixed:** Force the verifiable goal first, even if it means asking one clarifying question.

```typescript
// Agent: "To define 'fixed,' I need the specific symptom.
//   If the issue is 'users stay logged in after password change,' the verification is:
//     test: change password → old session token returns 401 on next request.
//   Is that the issue?"
// Once confirmed, the loop is: write the failing test, make it pass, ensure no regressions.
```

## Examples

The verification must be **executable**, not aspirational. "The code looks cleaner" is not a verification. "The function under test passes 4 new test cases and the existing 12 still pass" is. If the change resists executable verification entirely — e.g., a UI tweak — substitute a manual-but-defined check: "screenshot before, screenshot after, the button is now blue and the label reads 'Submit'." The point is repeatability: anyone running the verification gets the same yes/no.

The loop also terminates on a defined "I cannot verify this" — if three attempts to make the test pass leave the test still red, stop and surface the failure to the user with what was tried. Do not silently relax the verification.
