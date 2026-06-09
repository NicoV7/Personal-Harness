# BetterAI Corpus Schemas

This is the **first file you open** when you want to hand-author a rule, skill, or memory for the BetterAI corpus. It mirrors the schemas locked in the v4 design and the multi-agent eng review.

The corpus has three sibling artifact kinds:

- **Rules** are *constraints* — "DON'T do X, prefer Y". They are the moat.
- **Skills** are *procedures* — "HOW to do Y step-by-step".
- **Memories** are *episodes* — "LAST time we tried Z, this is what happened, don't relitigate".

Every artifact is a markdown file with YAML frontmatter. The frontmatter is what the MCP retrieval layer indexes; the body is what gets injected into an agent's context.

---

## Rule schema

**Location:** `rules/<CATEGORY>/<domain>/<id>.md`

### Frontmatter — required

| key       | type    | notes                                                            |
|-----------|---------|------------------------------------------------------------------|
| `id`      | string  | kebab-case, globally unique across the corpus                    |
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

**Location:** `skills/<category>/<id>.md`

Skills are procedures, not constraints. There is **no** `severity` field on skills.

### Frontmatter — required

| key            | type    | notes                                                            |
|----------------|---------|------------------------------------------------------------------|
| `id`           | string  | kebab-case, globally unique                                      |
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

**Location:** `memories/<yyyy-mm>/<id>.md`

Memories are episodes — past decisions, failures, discoveries, constraints. They are time-stamped and durability-tagged.

### Frontmatter — required

| key                 | type     | notes                                                            |
|---------------------|----------|------------------------------------------------------------------|
| `id`                | string   | kebab-case, globally unique                                      |
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

## Cross-cutting conventions

- **Examples are TypeScript** unless the rule is explicitly language-agnostic.
- **One code block per example.** Multiple code blocks per section dilute signal.
- **Don't repeat across artifacts.** If rule A and rule B overlap, pick one as canonical and `related: [other-id]` from the other.
- **File sizes:** rules 50-150 lines, skills 60-100 lines, memories 30-60 lines. Going much longer is a smell — split.
- **No placeholders.** Every section earns its keep or is removed.
