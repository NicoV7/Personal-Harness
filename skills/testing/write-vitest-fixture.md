---
id: write-vitest-fixture
title: Write a Vitest fixture for a BetterAI MCP handler or schema validator
category: testing
when_to_use: |
  When adding a Vitest integration or unit test for a BetterAI MCP handler,
  a schema validator, or a corpus loader. Trigger signals: you're about to
  add a new handler under `src/mcp-tools/`; you're fixing a bug and want a
  regression test; you're refactoring and need a safety net.
steps_count: 6
estimated_minutes: 15
applies_when:
  paths:
    - src/**/*.test.ts
    - tests/**
  intents:
    - write test
    - add test
    - fixture
    - vitest
related_rules:
  - no-catch-all-exception-masking
related_skills:
  - add-mcp-tool
created: 2026-06-09
---

## When to use this skill

Use this when authoring any Vitest test in the BetterAI repo. The shape is
load-bearing — handlers, validators, and loaders all share the same
arrange-act-assert skeleton so tests stay scannable. If you're tempted to
mock the filesystem or sqlite-vec wholesale, stop and read step 3 below.

Do NOT use this skill for end-to-end browser-driven tests (those live in
a different harness) or for benchmark scripts.

## Prerequisites

- Vitest installed (it is — see `package.json`). Run with `pnpm test` or
  `pnpm vitest --watch`.
- `tmpdir` helper at `src/test-utils/tmp-corpus.ts` for materializing a
  throwaway rules directory.
- The handler/validator under test exports its function (avoid testing
  through the MCP wire protocol unless that's specifically what you mean to
  cover).

## Steps

1. **Use arrange-act-assert structure** with comment markers (`// arrange`,
   `// act`, `// assert`) inside each `it()` block. This is non-negotiable
   for the corpus — tests should be readable without running them.
2. **Use `describe()` plus nested `describe()` for handlers.** Outer
   describe is the unit (`describe("retrieveByIntent", () => { ... })`);
   inner describes are scenarios (`describe("when intent is empty",
   () => { ... })`). Inner `it()` blocks state the assertion plainly:
   `it("rejects with code SCHEMA_ERROR", ...)`.
3. **Mock only at system boundaries (filesystem, sqlite-vec).** Do NOT mock
   the handler's collaborators inside `src/`. If you find yourself mocking
   internal modules, the design is wrong and you should refactor instead of
   accumulate `vi.mock()` calls. Allowed mocks: `node:fs` (rarely — prefer
   tmpdir), the sqlite-vec binding when you specifically want to assert
   query shape.
4. **Use a real in-memory rules dir (tmpdir).** Call
   `await makeTmpCorpus({ rules: [...] })` to materialize a real directory
   with real files, point the handler at it, and clean up in `afterEach`.
   This catches loader bugs that pure mocks hide.
5. **Assert audit JSONL contents** by reading the audit file written during
   the test and parsing each line. Snapshot-test the event shape, then
   assert specific fields (`event_type`, `client_id`, payload keys).
   Don't snapshot timestamps — strip them first.
6. **Run `pnpm vitest --watch` during dev** so the suite reruns on file
   change. When the test goes green, run `pnpm vitest run` once at the end
   to confirm a clean run from a cold start (catches stateful test
   pollution).

## What good looks like

A test file is short (under 200 lines for most handlers), every `it()`
block tells a story in its name, and the diff in a failing snapshot points
at the meaningful change. Example skeleton:

```typescript
// src/mcp-tools/retrieve_by_intent/handler.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { retrieveByIntent } from "./handler";
import { makeTmpCorpus, readAudit } from "../../test-utils/tmp-corpus";

describe("retrieveByIntent", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTmpCorpus({ rules: [seedRule] }); });
  afterEach(async () => { await ctx.cleanup(); });

  describe("when intent matches a rule", () => {
    it("returns the rule and writes an audit event", async () => {
      // arrange
      const input = { intent: "error handling", limit: 5 };
      // act
      const result = await retrieveByIntent(input, ctx);
      // assert
      expect(result.rules).toHaveLength(1);
      const events = await readAudit(ctx.auditPath);
      expect(events[0]).toMatchObject({ event_type: "retrieve_by_intent.invoked" });
    });
  });
});
```

## Common failure modes

- **Mocking inside `src/`.** Internal mocks couple the test to the
  implementation and make refactors painful. Mock at boundaries only.
- **Skipping audit assertions.** The audit JSONL is the source of truth for
  later analysis; an untested audit write becomes a silent bug.
- **Snapshot tests with timestamps.** Tests go red on every run because
  `Date.now()` differs. Strip volatile fields before snapshotting.
- **No `afterEach` cleanup.** Tmpdirs leak, the test suite slows down, and
  CI eventually fills the runner disk.
- **Testing through the MCP wire protocol.** Adds latency, hides handler
  bugs behind transport noise. Test the handler function directly unless
  you're specifically testing the transport.
- **Generic `it()` names.** `it("works")` tells you nothing when CI fails
  at 2am. Names should state the assertion.

## Python port note

The Python backend (`BetterAI-Python/backend/`) carries the same test
contract in pytest form: tests live feature-first under
`tests/<feature>/{unit,integration,e2e,evals}/`; each test keeps literal
`# arrange` / `# act` / `# assert` comments; mocks happen only at system
boundaries (httpx transport, redis client, psycopg connection, docker
socket) with `tmp_path` for filesystem fixtures instead of a tmpdir helper;
container-backed tests are marked `@pytest.mark.integration` and
live-server tests `@pytest.mark.e2e`. Audit assertions read the JSONL file
the same way — parse lines, strip timestamps, assert `event_type` and
payload keys. The Vitest guidance above remains authoritative for `src/`
until switchover.

## Related rules

- `no-catch-all-exception-masking` — tests should let typed errors bubble
  and assert on them, not catch-and-ignore.
