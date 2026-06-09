# BetterAI Corpus Schemas

This is the **first file you open** when you want to hand-author a rule, skill, or memory for the BetterAI corpus. It mirrors the schemas locked in the v4 design and the multi-agent eng review.

The corpus has three sibling artifact kinds:

- **Rules** are *constraints* — "DON'T do X, prefer Y". They are the moat.
- **Skills** are *procedures* — "HOW to do Y step-by-step".
- **Memories** are *episodes* — "LAST time we tried Z, this is what happened, don't relitigate".

Every artifact is a markdown file with YAML frontmatter. The frontmatter is what the MCP retrieval layer indexes; the body is what gets injected into an agent's context.

---

## Scope axis

Every artifact lives in exactly one of two corpus *roots*. The schema is identical in both; the only difference is **where the file lives on disk**, which determines who sees it and how overrides work.

### The two roots

- **GLOBAL corpus** — `~/.betterai/{rules,skills,memories,_meta}/` on the host. Inside the MCP server container this mounts at `/data/`. Global artifacts are *your personal moat*: they apply to every project you touch from this machine.
- **REPO corpus** — `<repo-root>/.betterai/{rules,skills,memories}/` on the host. Inside the container this is reachable at `/projects/<repo-rel>/.betterai/` via the existing `~/projects:/projects:ro` mount (no new mount required). Repo artifacts are *version-controlled with the project*: they ship in the repo, get PR'd like code, and survive team handoffs.

A repo corpus is detected at retrieval time by walking up from `context.file_paths[0]` until a `.git/` directory is found; if that repo root contains a `.betterai/` directory, it's the active repo corpus. The detection is cached for 60s keyed on the mtime of `<repo-root>/.git/HEAD` so branch switches invalidate cleanly.

### Scope is implicit from location — there is no `scope` field

The frontmatter does **not** carry a `scope: global | repo` key. The scope of an artifact is fully determined by which root the file lives in. This keeps the schema identical across the two roots and makes "move a rule from global to repo" a literal `git mv` rather than a frontmatter edit.

### Override semantics (id-collision)

The retrieval pipeline runs the domain-router + grep retrieval against **both** corpora and merges the results. The merge rule is:

- **Distinct ids:** repo and global artifacts with unique ids both appear; ranking (severity × match-strength × recency) orders them. Repo gets no automatic boost.
- **Id collision:** if the same `id` appears in both corpora, the **repo version replaces the global version** in the response. The global is dropped — the agent never sees it. This is the override pattern: a project re-declares the rule with the same id to say "this constraint is different *here*."

Overrides are recorded in the audit log (`overridden_global_ids: string[]`) so they're visible to future-you without surprise. Every returned item carries a `scope: "global" | "repo"` field so the agent can see which root supplied each artifact.

### When to author repo vs global

- **Global:** "no broad catch blocks", "always pin dependency versions", "never log PII". Beliefs that apply everywhere you write code.
- **Repo:** "this codebase uses camelCase, not snake_case", "all timestamps in this service are UTC ms since epoch", "auth tokens never log even at debug". Project-specific overrides or additions.

The default for `betterai new rule` is `--scope repo` when CWD is inside a git repo with a `.betterai/` directory (or one can be scaffolded); else `--scope global`.

---

## Rule schema

**File location:**

- Global: `~/.betterai/rules/<CATEGORY>/<domain>/<id>.md` (container: `/data/rules/<CATEGORY>/<domain>/<id>.md`)
- Repo: `<repo-root>/.betterai/rules/<CATEGORY>/<domain>/<id>.md` (container: `/projects/<repo-rel>/.betterai/rules/<CATEGORY>/<domain>/<id>.md`)

Same `<CATEGORY>/<domain>/<id>.md` layout in both roots. The directory shape is identical; scope is the directory you put it under.

### Frontmatter — required

| key       | type    | notes                                                            |
|-----------|---------|------------------------------------------------------------------|
| `id`      | string  | kebab-case, globally unique *within a scope* (id-collision across scopes is the override mechanism, not an error) |
| `title`   | string  | <80 characters, sentence-case, no trailing period                |
| `category`| enum    | `STANDARDS` \| `PROCESS` \| `PATTERNS` \| `ARCHITECTURE` \| `DOCUMENTATION` |
| `domain`  | string  | free-form domain tag (e.g. `maintainability`, `error-handling`)  |
| `severity`| enum    | `low` \| `medium` \| `high`                                      |
| `created` | date    | ISO date, `2026-06-09`                                           |

### Frontmatter — optional

| key            | type     | notes                                                                |
|----------------|----------|----------------------------------------------------------------------|
| `applies_when` | object   | `{ paths: [glob], symbols: [string], intents: [string] }`            |
| `check`        | object   | `{ kind: "regex" \| "ast-grep", pattern: string }` (NO `shell`, NO `ts-module`) |
| `fix_template` | string   | brief patch hint, ≤200 chars                                         |
| `source`       | string   | URL or citation                                                      |
| `related`      | string[] | other artifact ids to cross-link                                     |
| `last_fired`   | date     | maintained by the retrieval layer, not by humans                     |
| `fire_count`   | number   | maintained by the retrieval layer, not by humans                     |

### Body — required sections, in this order

1. `## What this rule says` — one-paragraph statement of the constraint.
2. `## Why it matters` — the cost of violating it.
3. `## When this applies` — concrete trigger conditions.
4. `## What good looks like` — concrete code or text showing compliance.
5. `## Anti-patterns` — a wrong example AND a fixed example, briefly.
6. `## Examples` — optional but recommended. One TypeScript code block per example.

### Worked example — rule

> *Scope: GLOBAL.* This rule applies across every project you work in; it lives in `~/.betterai/rules/STANDARDS/error-handling/no-broad-catch.md`.

```markdown
---
id: no-broad-catch
title: Don't swallow errors with broad catch blocks
category: STANDARDS
domain: error-handling
severity: high
created: 2026-06-09
applies_when:
  paths: ["**/*.ts"]
related: [error-boundaries-at-the-edge]
---

## What this rule says

A `catch` block that catches every error type and silently returns a fallback
hides bugs and turns crashes into data corruption.

## Why it matters

A swallowed error in a billing or auth path becomes a phantom: the user sees
success, the database sees nothing, support sees a contradiction.

## When this applies

Any `try/catch` in `.ts` files where the catch clause has no rethrow, no log,
and no narrowed error type.

## What good looks like

Narrow the catch, log with context, and rethrow or return a typed failure.

```ts
try {
  await charge(invoice);
} catch (err) {
  if (err instanceof StripeRetryableError) return { retry: true };
  logger.error({ err, invoiceId: invoice.id }, "charge failed");
  throw err;
}
```

## Anti-patterns

Wrong:

```ts
try { await charge(invoice); } catch { return null; }
```

Fixed: see "What good looks like".
```

---

## Skill schema

**File location:**

- Global: `~/.betterai/skills/<category>/<id>.md` (container: `/data/skills/<category>/<id>.md`)
- Repo: `<repo-root>/.betterai/skills/<category>/<id>.md` (container: `/projects/<repo-rel>/.betterai/skills/<category>/<id>.md`)

Skills are procedures, not constraints. There is **no** `severity` field on skills.

### Frontmatter — required

| key            | type    | notes                                                            |
|----------------|---------|------------------------------------------------------------------|
| `id`           | string  | kebab-case, globally unique *within a scope*                     |
| `title`        | string  | <80 chars                                                        |
| `category`     | string  | `corpus-management` \| `mcp-development` \| `testing` \| `release` \| ... (grow as needed) |
| `when_to_use`  | string  | **REQUIRED** — the trigger description, multi-line OK            |
| `steps_count`  | number  | number of steps in the body                                      |
| `created`      | date    | ISO date                                                         |

### Frontmatter — optional

| key                 | type     | notes                                              |
|---------------------|----------|----------------------------------------------------|
| `estimated_minutes` | number   | rough wall-clock cost                              |
| `applies_when`      | object   | same shape as rule frontmatter                     |
| `codified_from`     | string   | source memory id, if the skill was extracted from a past episode |
| `related_rules`     | string[] |                                                    |
| `related_skills`    | string[] |                                                    |

### Body — required sections

1. `## When to use this skill`
2. `## Prerequisites`
3. `## Steps`
4. `## What good looks like`
5. `## Common failure modes`
6. `## Related rules`

### Worked example — skill

> *Scope: GLOBAL.* This skill applies to any corpus you maintain on this machine; it lives in `~/.betterai/skills/corpus-management/add-new-rule.md`.

```markdown
---
id: add-new-rule
title: Add a new rule to the corpus
category: corpus-management
when_to_use: |
  When you've spotted a recurring code-review comment, a constraint the team
  keeps re-deriving, or an anti-pattern you want future agents to refuse.
steps_count: 5
created: 2026-06-09
related_rules: [rule-frontmatter-complete]
---

## When to use this skill

You want to encode a new constraint into the moat.

## Prerequisites

- You can name the rule in a sentence.
- You have one example of code that violates it and one that satisfies it.

## Steps

1. Pick the category (STANDARDS / PROCESS / PATTERNS / ARCHITECTURE / DOCUMENTATION).
2. Pick the domain — reuse an existing folder under that category if possible.
3. Create `rules/<CATEGORY>/<domain>/<id>.md` with the frontmatter from `schema.md`.
4. Write all six body sections; do not stub.
5. Add `related: [...]` cross-links to neighboring rules.

## What good looks like

A 50-150 line file, every section non-trivial, "What good looks like" contains
real TypeScript.

## Common failure modes

- Frontmatter `category` lowercased — must be uppercase enum.
- Body restates the title in every section instead of adding information.

## Related rules

- `rule-frontmatter-complete`
```

---

## Memory schema

**File location:**

- Global: `~/.betterai/memories/<yyyy-mm>/<id>.md` (container: `/data/memories/<yyyy-mm>/<id>.md`)
- Repo: `<repo-root>/.betterai/memories/<yyyy-mm>/<id>.md` (container: `/projects/<repo-rel>/.betterai/memories/<yyyy-mm>/<id>.md`)

Memories are episodes — past decisions, failures, discoveries, constraints. They are time-stamped and durability-tagged. Repo-scoped memories are particularly valuable for "we decided X for *this* service" notes that should travel with the code.

### Frontmatter — required

| key                 | type     | notes                                                            |
|---------------------|----------|------------------------------------------------------------------|
| `id`                | string   | kebab-case, globally unique *within a scope*                     |
| `title`             | string   | <80 chars                                                        |
| `date`              | date     | ISO date when the *episode* happened (not when you wrote it down)|
| `project`           | string   | `betterai`                                                       |
| `kind`              | enum     | `decision` \| `failure` \| `discovery` \| `constraint`           |
| `context_keywords`  | string[] | lowercase tags for retrieval                                     |
| `durability`        | enum     | `short` \| `medium` \| `long`                                    |
| `auto_captured`     | boolean  | `false` for hand-written memories                                |

### Frontmatter — optional

| key                          | type     | notes                                          |
|------------------------------|----------|------------------------------------------------|
| `applies_to_future_intents`  | string[] | intent keywords this memory should fire on    |
| `related_rules`              | string[] |                                                |
| `related_memories`           | string[] |                                                |
| `expires_on`                 | date     | for `short` durability memories                |

### Body — required sections

1. `## What happened`
2. `## Why it matters (for future me)`
3. `## Don't relitigate` — explicit assertion that future-agent should not re-open this territory.

### Worked example — memory

> *Scope: GLOBAL.* This is a corpus-design decision that applies across every project; it lives in `~/.betterai/memories/2026-06/dropped-shell-and-ts-module-checks.md`. A *repo-scoped* memory would look identical but live in `<repo-root>/.betterai/memories/2026-06/...`.

```markdown
---
id: dropped-shell-and-ts-module-checks
title: Dropped shell and ts-module as rule check kinds
date: 2026-06-09
project: betterai
kind: decision
context_keywords: [corpus, schema, check-kinds, security]
durability: long
auto_captured: false
applies_to_future_intents: [add-check-kind, extend-rule-schema]
related_rules: []
---

## What happened

During schema design we considered four check kinds: `regex`, `ast-grep`,
`shell`, and `ts-module`. We dropped `shell` (arbitrary command execution
inside the retrieval pipeline is a supply-chain hole) and `ts-module`
(loading user code at index time defeats the sandbox).

## Why it matters (for future me)

If a future contributor proposes "let's just allow a small shell hook for
custom checks," the answer is no — the threat model already rejected it.

## Don't relitigate

Do not add `shell` or `ts-module` to the `check.kind` enum. If you need
dynamic checks, write an `ast-grep` pattern or open a design doc that
addresses the sandboxing model first.
```

---

## Authoring a repo-scoped artifact

When you want a rule, skill, or memory to ship with a specific project rather than apply globally, author it under the repo corpus. The workflow:

1. **Confirm or scaffold the repo corpus.** From inside the repo, run `betterai status`. If the output doesn't list a `REPO` line, run `betterai new rule --scope repo` once — it will create `<repo-root>/.betterai/{rules,skills,memories}/` and a one-line `README.md` if missing.
2. **Pick the right scope.** If the constraint is "we do it differently in *this* codebase" (camelCase vs snake_case, UTC vs local time, this DB vs that DB), it's repo. If it's "I always do it this way everywhere" (no swallowed errors, no PII in logs), it's global.
3. **Author with the same schema.** Use the exact same frontmatter and body sections as a global artifact. The schema is identical; only the location differs.
4. **Decide on override vs addition.** To *override* a global rule for this repo, reuse the global rule's `id` — the retrieval layer will drop the global and serve the repo version. To *add* a project-specific rule that doesn't replace anything global, use a fresh, unique `id`.
5. **Commit it.** Repo-scoped artifacts are version-controlled with the project. `git add .betterai/` and PR them like code. The override behavior is recorded in the audit log (`overridden_global_ids`), so reviewers can see what's being replaced.

---

## Cross-cutting conventions

- **Examples are TypeScript** unless the rule is explicitly language-agnostic.
- **One code block per example.** Multiple code blocks per section dilute signal.
- **Don't repeat across artifacts.** If rule A and rule B overlap, pick one as canonical and `related: [other-id]` from the other.
- **File sizes:** rules 50-150 lines, skills 60-100 lines, memories 30-60 lines. Going much longer is a smell — split.
- **No placeholders.** Every section earns its keep or is removed.
- **Id uniqueness is per-scope.** Id collisions across scopes are the override mechanism, not a validation error. `betterai validate` reports cross-scope id collisions as INFO, not ERROR.
