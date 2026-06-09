---
id: think-before-coding
title: Surface assumptions and interpretations before writing code
category: PROCESS
domain: methodology
severity: medium
created: 2026-06-09
applies_when:
  intents: [plan, implement]
related: [search-context-before-substantive, ask-about-non-functionals, simplicity-first]
source: RULES.md rule 5
---

## What this rule says

Before implementing, do three things in plain prose: **state your assumptions explicitly, list the multiple interpretations the request could carry, and name any simpler approach you considered**. Then either ask the user to choose, or pick one and explain why. Never pick silently. Never hide a tradeoff because surfacing it feels like friction.

A request like "export user data" carries at least four buried decisions (scope, delivery mechanism, field set, volume) and any of them can be wrong. A request like "make the search faster" can mean three different things (lower latency, higher throughput, better perceived speed) with three different implementations. Writing code before surfacing these is gambling — sometimes the agent guesses right, but the cost of guessing wrong is rewriting work that should not have been written.

## Why it matters

The model is fluent enough to make a guess look like an answer. A confidently-written 200-line implementation of the wrong interpretation costs the same to read and review as the right one, but the user has to figure out which it is. Surfacing assumptions inverts the cost: a 30-second clarifying paragraph from the agent saves the user a 30-minute review of code that has to be redone.

The other failure mode silent picking creates is invisible disagreement. The user gets working code that does something close to what they asked, but quietly different. They may not notice until production. Whereas an explicit "I assumed X because of Y — confirm?" produces either confirmation (cheap) or correction (also cheap), both before any code is written.

## When this applies

- The request uses a verb whose object is ambiguous: "export," "improve," "fix," "make faster," "clean up."
- The request omits a non-functional that materially affects the design: scale, latency target, privacy class, persistence.
- Multiple reasonable interpretations exist and they would lead to different code.
- The agent notices a simpler approach the user did not ask for. Name it; let the user choose.
- The agent is about to make a tradeoff the user has not been told about (memory vs latency, simplicity vs flexibility).

It does NOT apply when the request is already concrete and self-contained: "add a `--verbose` flag that prints the route table on startup" has no hidden assumptions worth surfacing.

## What good looks like

Before any code, a short structured response that names the assumptions, names the interpretations, and asks the question that resolves them.

```typescript
// User: "Add a feature to export user data"

// Good response (no code yet):
// "Before implementing, I need to surface a few assumptions:
//
// 1. Scope: all users in the system, or a filtered subset (e.g., one team)?
//    Privacy implications differ.
// 2. Delivery: file download in the browser, a background job that emails a link,
//    or an API endpoint returning JSON?
// 3. Fields: which columns? Some are sensitive (email, ip, last_login).
// 4. Volume: rough order — hundreds, thousands, millions? Affects approach.
//
// Simplest viable implementation: a paginated JSON endpoint at GET /users
// returning non-sensitive fields. Adding CSV download or background-job
// flavors are easy to bolt on later if needed.
//
// Want me to proceed with the simplest version, or pick a different shape?"
```

For ambiguity in performance work:

```typescript
// User: "Make the search faster"

// Good response:
// "'Faster' could mean three different things, each pointing at a different fix:
//
//   1. Lower response time per query: add an index, cache hot queries.
//      Today: ~500ms typical. Target: ~100ms?
//   2. Higher concurrent throughput: async handlers, connection pool.
//      Today: ~50 req/s. Bottleneck at peak?
//   3. Better perceived speed: stream partial results, progressive loading.
//      Today: spinner until full result. UX-focused.
//
// Which one is the pain point? They have different implementations and
// I want to avoid building all three when one would do."
```

## Anti-patterns

**Wrong:** Silently pick one interpretation, implement it, ship it.

```typescript
// User: "Add a feature to export user data"
// Agent immediately writes:

function exportUsers(format = "json") {
  const users = User.query.all();  // exports ALL users — assumed scope
  if (format === "json") {
    fs.writeFileSync("users.json", JSON.stringify(users));  // assumed file location
  }
  // assumed field set, assumed delivery mechanism
}
// Four hidden assumptions, none surfaced. User now has to read the diff
// to discover that "export" meant something different to them.
```

**Fixed:** Name the assumptions in prose, propose the simplest interpretation, ask.

```typescript
// Agent surfaces the four ambiguities, proposes "paginated JSON endpoint
// returning non-sensitive fields" as the simplest viable shape, and asks
// the user to confirm or redirect before any code is written.
```

## Examples

The pattern generalizes beyond ambiguity to tradeoffs the user did not flag. If the user asks for "a config-driven retry mechanism" and the simplest implementation needs no config (one constant in a file), name that. "You asked for config-driven; I notice a single constant would work today and is half the code. Want config-driven anyway because you expect to tune it, or is the constant fine?" The user gets to make the tradeoff knowingly. The agent does not silently pick "more flexible" because more-flexible feels safer.

A common shortcut to resist: "the user is busy, I'll just pick the reasonable interpretation." The user is busy precisely because they cannot afford to debug your interpretation later. The clarifying paragraph is the cheap part of the interaction.
