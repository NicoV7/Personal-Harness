---
id: layered-architecture-default
title: Default to 7-layer split when scaffolding a new TS/Node module
category: ARCHITECTURE
domain: layering
severity: medium
created: 2026-06-09
applies_when:
  paths:
    - "src/**"
    - "app/**"
    - "server/**"
  intents:
    - scaffold
    - "new module"
    - plan
source: RULES.md §6 (line 61-62)
related:
  - no-god-files
  - simplicity-first
---

## What this rule says

When scaffolding a new module in a TypeScript/Node service, default to a 7-layer split: `service/`, `models/`, `dtos/`, `tests/`, `tools/`, `constants/`, `handlers/`. Each layer has one job:

- **handlers/** — transport-level entry points (HTTP route handlers, MCP tool callbacks, CLI commands). Parse input, call a service, format the response. No business logic.
- **service/** — business logic. Pure functions where possible; coordinates models and tools.
- **models/** — persistence-shaped types and DB access (or wrappers around an ORM/storage client).
- **dtos/** — transport-shaped types: request/response shapes, Zod schemas. Distinct from models because the wire format and the storage format drift.
- **tools/** — adapters to external systems: fs, network, child processes, third-party SDKs. Anything you'd want to swap in a test.
- **constants/** — module-local constants (paths, magic strings, defaults). Keeps strings out of logic.
- **tests/** — colocated unit tests for the above. Integration tests can live elsewhere.

Pick this layout by default; deviate only with a reason.

## Why it matters

Three concrete wins:

1. **Discoverability.** A new agent (or future-you) opening `src/corpus/` knows exactly where the rule-loading code lives (`service/`), where the on-disk shape is defined (`dtos/`), and where the fs adapter lives (`tools/`). No archaeology.
2. **Testability.** Services that depend on `tools/*` interfaces can be tested without real fs/network. The split is what makes that possible — a handler that opens files inline cannot be unit-tested without mocking the world.
3. **Ownership.** When a bug report says "responses are malformed", you go to `dtos/` and `handlers/`. When it says "the wrong rules are loading", you go to `service/`. The layer narrows the search before you read a single line.

The cost of the layout is a few extra files. The cost of NOT having it shows up the third time you touch the module.

## When this applies

**Applies:**
- A new module in a TS/Node service that will grow beyond 3 files.
- Modules that have any of: persistence, external I/O, or a transport surface (HTTP, MCP, CLI).
- The BetterAI codebase specifically — this is the house style.

**Skip:**
- Single-file utility libraries (`src/utils/slug.ts`) — one file, no layers needed.
- Throwaway scripts in `scripts/`.
- Non-TS/Node stacks. Python/Django uses apps with `models.py` / `views.py` / `serializers.py`; Rails uses `app/models` / `app/controllers`. Those have their own conventions — do not force the 7-layer split onto them.
- Generated code directories.

If a module starts as a single file and grows, refactor into the layout when it crosses ~3 files OR when a second concern (e.g., persistence + HTTP) lands in the same file.

## What good looks like

A new `corpus` module in BetterAI:

```
src/corpus/
  handlers/
    search.handler.ts        # MCP tool: search_rules → calls service
    fetch.handler.ts         # MCP tool: fetch_rule
  service/
    search.service.ts        # ranking, filtering, conflict resolution
    load.service.ts          # walks the rules dir, parses frontmatter
  models/
    rule.model.ts            # on-disk Rule shape + fs access
  dtos/
    search.dto.ts            # Zod schema for MCP search input/output
    rule.dto.ts              # wire-format Rule (subset of model)
  tools/
    fs.tool.ts               # readFile/readdir wrapper (swappable in tests)
    yaml.tool.ts             # frontmatter parser wrapper
  constants/
    paths.ts                 # RULES_DIR, MEMORIES_DIR
    defaults.ts              # DEFAULT_SEVERITY, MAX_RESULTS
  tests/
    search.service.test.ts
    load.service.test.ts
  index.ts                   # public surface; re-exports handlers
```

The handler is thin:

```ts
// handlers/search.handler.ts
import { searchRules } from "../service/search.service";
import { SearchInput, SearchOutput } from "../dtos/search.dto";

export const searchHandler = async (raw: unknown): Promise<SearchOutput> => {
  const input = SearchInput.parse(raw);
  return searchRules(input);
};
```

All the interesting code lives in `service/`. The handler is two lines plus a parse.

## Anti-patterns

**Wrong — everything in one file:**

```ts
// src/corpus.ts  (eventually 1800 lines)
export async function searchRules(query: string) {
  const dir = "/Users/me/BetterAI/rules";       // constant inline
  const files = await fs.readdir(dir);           // tool inline
  const parsed = files.map(parseFrontmatter);    // model inline
  // ... ranking, filtering, formatting, all here
  return { results: parsed };                    // dto inline
}
```

One file owns the constant, the fs adapter, the model, the ranking logic, and the wire shape. Untestable without real fs. Unfindable when it grows.

**Fixed — split by layer:**

```ts
// service/search.service.ts
import { RULES_DIR } from "../constants/paths";
import { listRules } from "../tools/fs.tool";
import { parseRule } from "../models/rule.model";
import { SearchInput, SearchOutput } from "../dtos/search.dto";

export const searchRules = async (
  input: SearchInput,
  fs = { listRules },          // injectable for tests
): Promise<SearchOutput> => {
  const files = await fs.listRules(RULES_DIR);
  const rules = await Promise.all(files.map(parseRule));
  return { results: rank(rules, input.query) };
};
```

The fs adapter is injectable. The constants live in `constants/`. The wire shape is enforced by `SearchOutput`. The service has one job: search.

**Wrong — handler with embedded DB queries:**

```ts
// handlers/search.handler.ts
export const searchHandler = async (req) => {
  const rows = await db.query("SELECT * FROM rules WHERE ...");  // model inline
  return res.json(rows);                                          // no dto boundary
};
```

A bug in the SQL is now a "handler bug". The HTTP layer and the storage layer are fused.

**Fixed:** push the query into `models/rule.model.ts`, push the ranking into `service/search.service.ts`, leave the handler as parse → service → respond.

## Examples

Counter-example to remember: utility libraries do NOT get the 7-layer treatment. A `src/utils/slug.ts` with one exported function and one test is correct as-is:

```
src/utils/
  slug.ts
  slug.test.ts
```

Forcing `utils/slug/service/slug.service.ts` here is cargo-culting the rule. The trigger is **module with multiple concerns**, not **every directory**. When in doubt: if the module has zero external I/O and zero transport surface, the layered split is overhead. Apply the rule where the layers earn their keep.
