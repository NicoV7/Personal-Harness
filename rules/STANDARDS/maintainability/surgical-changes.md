---
id: surgical-changes
title: Surgical changes — touch only what the request requires
category: STANDARDS
domain: maintainability
severity: high
created: 2026-06-09
applies_when:
  paths:
    - "**/*.ts"
    - "**/*.py"
    - "**/*.js"
    - "**/*.tsx"
  intents:
    - implement
    - refactor
    - fix
related:
  - simplicity-first
---

## What this rule says

When editing existing code, touch only what you must to satisfy the user's
request. Do not "improve" adjacent code, do not reformat, do not add type
hints or docstrings that weren't asked for, do not refactor things that
aren't broken, and do not delete pre-existing dead code on the way through.

Match the file's existing style, even if you would have written it differently
from scratch. If you notice unrelated problems, surface them as a comment or a
follow-up — don't silently expand the scope of the diff.

The single-line test: every changed line should trace directly to the user's
request. If you can't say *which sentence in the request* a line implements,
revert that line.

## Why it matters

Drive-by edits make diffs unreviewable. A 3-line bug fix buried in 40 lines of
unrelated reformatting forces the reviewer (human or agent) to verify the
whole change set, multiplies merge-conflict surface area, breaks `git blame`,
and risks introducing new bugs in code that was working fine. Style drift —
quote style, type-hint additions, whitespace — pollutes the codebase with
inconsistent conventions and erodes trust in the agent's edits.

In an AI-agent codebase specifically, surgical discipline is what lets a human
skim a diff and confidently approve it. Without it, every PR turns into a
full re-read.

## When this applies

- Bug fixes: change only the lines that fix the bug.
- Adding a feature in an existing file: add new code; don't rewrite surrounding
  code "while you're in there."
- Adding logging, instrumentation, or telemetry: insert the calls; don't
  refactor the function being instrumented.
- Cleaning up orphans: remove imports/symbols *your* change made unused. Don't
  remove pre-existing dead code.

Does NOT apply when the request is explicitly a refactor or cleanup — then the
whole point is to touch the adjacent code.

## What good looks like

The user reports "empty emails crash the validator." The fix changes only the
email-handling lines and leaves username validation, comments, and signatures
alone:

```ts
// Good: only the lines that handle empty email change.
function validateUser(user: { email?: string; username?: string }) {
  // Check email format
  const email = user.email ?? "";
  if (!email.trim()) {
    throw new Error("Email required");
  }
  if (!email.includes("@")) {
    throw new Error("Invalid email");
  }

  // Check username  ← untouched
  if (!user.username) {
    throw new Error("Username required");
  }
  return true;
}
```

The user asks for "logging on upload." The diff adds the logger import and the
log calls — and nothing else. Quote style, return-value shape, and existing
whitespace stay exactly as they were.

## Anti-patterns

Drive-by refactoring while fixing a bug: the fix is correct, but the diff also
"improves" the email regex, adds username length and alphanumeric checks
nobody asked for, adds a docstring, and rewords the comments. The reviewer
now has to verify five unrelated changes to approve a one-line bug fix.

```ts
// Anti-pattern: the user said "fix empty email crash."
// This diff also added: username min-length, alphanumeric check, docstring,
// reworded comments, restructured the function. Reject.
function validateUser(user: { email?: string; username?: string }) {
  /** Validate user data. */
  const email = (user.email ?? "").trim();
  if (!email) throw new Error("Email required");
  if (!email.includes("@") || !email.split("@")[1].includes(".")) {
    throw new Error("Invalid email");
  }
  const username = (user.username ?? "").trim();
  if (!username) throw new Error("Username required");
  if (username.length < 3) throw new Error("Username too short");      // not asked
  if (!/^[a-z0-9]+$/i.test(username)) throw new Error("Alphanumeric"); // not asked
  return true;
}
```

Fix: revert the unrelated lines. Mention "noticed username lacks length check
— want a separate ticket?" in the PR description.

Style drift while adding logging: the diff changes single quotes to double
quotes, adds type hints, adds a docstring, reformats whitespace, and flips a
boolean's representation — all because the agent's defaults differ from the
file's existing style. Match the file. The codebase's consistency is more
valuable than your preferences.

## Examples

Reviewer's heuristic: look at the diff and ask "if I removed any individual
hunk, would the user's stated goal still be met?" If yes, that hunk doesn't
belong in this PR. Move it to a follow-up or drop it entirely.
