# Authoring rules, skills, and memories

This is the day-to-day reference for adding content to the BetterAI corpus. The schema is locked in [`rules/_meta/schema.md`](../rules/_meta/schema.md); this doc is the operator's manual on top of it.

Two paths: the lazy one (`betterai new`) and the manual one (open your editor).

---

## The lazy path

```bash
# Author a rule in the active repo's corpus (default if you're inside a git repo
# with a .betterai/ directory or one can be scaffolded).
betterai new rule

# Author globally instead.
betterai new rule --scope global

# Skills and memories use the same verb.
betterai new skill --scope global
betterai new memory --scope repo
```

The interactive walk asks for:

1. **The id.** kebab-case, globally unique within the chosen scope. Example: `no-broad-catch`. Id collisions across scopes are the override mechanism, not an error — see "The override pattern" below.
2. **The title.** One sentence, under 80 characters, no trailing period.
3. **The category** (rules only) — STANDARDS / PROCESS / PATTERNS / ARCHITECTURE / DOCUMENTATION.
4. **The domain** (rules only) — free-form tag (`maintainability`, `error-handling`, `naming`, ...).
5. **The severity** (rules only) — low / medium / high.

Then it scaffolds the file with all required H2 sections stubbed out and opens it in `$EDITOR`. When you save and quit, it runs `betterai validate` on the new file so the frontmatter is correct before the file lands on disk.

`betterai new` is the recommended path. It eliminates the "I forgot a frontmatter field, the retrieval layer silently dropped the rule, and the corpus quietly rotted" failure mode.

---

## The manual path

When you want to hand-write a file (or import an existing markdown file from elsewhere), open `rules/<CATEGORY>/<domain>/<id>.md` and write:

````markdown
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

A `catch` block that catches every error type and silently returns a
fallback hides bugs and turns crashes into data corruption.

## Why it matters

A swallowed error in a billing or auth path becomes a phantom: the user
sees success, the database sees nothing, support sees a contradiction.

## When this applies

Any try/catch in .ts files where the catch clause has no rethrow, no log,
and no narrowed error type.

## What good looks like

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
````

The six H2 sections (`What this rule says`, `Why it matters`, `When this applies`, `What good looks like`, `Anti-patterns`, optional `Examples`) MUST appear in this order. The validator enforces it. The frontmatter MUST include `id`, `title`, `category`, `domain`, `severity`, `created` (all required) — see [`rules/_meta/schema.md`](../rules/_meta/schema.md) for the full table including optional fields like `applies_when`, `check`, `related`, `fix_template`.

Skills and memories follow the same shape with different required H2s and frontmatter — full schema again in `rules/_meta/schema.md`.

---

## Repo vs global scope: when to pick which

The schema is identical in both roots. The only difference is **where the file lives on disk**, which determines who sees it and how overrides work.

| Pick repo when... | Pick global when... |
|---|---|
| "We do it differently in *this* codebase." camelCase vs snake_case. UTC vs local. This DB vs that DB. | "I always do it this way everywhere." No swallowed errors. No PII in logs. Dependency injection over service locators. |
| The constraint ships with the project; reviewers should see it during PR. | The constraint is a property of you, not of any one project. |
| Other developers on the team need to inherit it. | Only you (across all your machines) need it. |

The default for `betterai new` is `--scope repo` when CWD is inside a git repo with (or that can scaffold) a `.betterai/` directory. Otherwise it falls back to `--scope global`.

For the full rationale on scope semantics, conflict resolution, and the detection algorithm, read [`docs/design/v4.1-scoping-extension.md`](design/v4.1-scoping-extension.md).

---

## The override pattern

To override a global rule for a single repo, **re-declare the rule in the repo corpus with the same `id`**. The retrieval layer notices the collision and drops the global version from the response — the agent sees only the repo version. The override is recorded in the audit log under `overridden_global_ids` so future-you (or a teammate doing a PR review) can see what was replaced.

Worked example. Global rule `use-snake-case`:

```yaml
# ~/.betterai/rules/STANDARDS/naming/use-snake-case.md
id: use-snake-case
title: Use snake_case for identifiers
severity: medium
```

Body: "Use snake_case for variable, function, and file names."

Now you're working in a React project and want camelCase. Author this in the repo:

```yaml
# <repo-root>/.betterai/rules/STANDARDS/naming/use-snake-case.md
id: use-snake-case
title: Use camelCase for identifiers in this React codebase
severity: high
```

Body: "This codebase follows React community convention: camelCase for variables and functions, PascalCase for components, kebab-case for filenames. The global snake_case rule does not apply here."

Same id, different body, different severity. The retrieval pipeline:

- detects the repo root by walking up to `.git/`,
- runs the domain-router + grep against BOTH corpora,
- notices the id collision,
- drops the global rule from the response,
- returns only the repo version to the agent,
- writes `overridden_global_ids: ["use-snake-case"]` to the audit event.

The agent never sees both versions. Reviewers can see the override via `betterai status` or the audit log.

**To add a project-specific rule without replacing a global one,** use a fresh, unique id. The non-colliding repo rule joins the response additively; both global and repo rules appear, ranked normally.

---

## Validate before committing

```bash
betterai validate
```

The CLI walks `~/.betterai/` AND any detected repo corpus. It reports:

- **ERROR** — missing required frontmatter, invalid enum value, missing required H2 section, malformed `check.kind`, duplicate `id` within a scope, dropped check kind (`shell`, `ts-module`).
- **WARNING** — title over 80 chars or with trailing period, related ref pointing at an unknown id, expired short-durability memory, memory in the wrong yyyy-mm shard.
- **INFO** — cross-scope id-collision (the override mechanism). Not an error.

Exit code is non-zero on any ERROR; warnings and infos are reported but don't fail the run.

The validator runs offline — no container, no docker, no network. This is on purpose: the inner authoring loop (write → validate → fix → commit) MUST be sub-second. See [`.betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md`](../.betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md) for why.

---

## Size discipline

- Rules: 50–150 lines per file. Going much longer is a smell — split.
- Skills: 60–100 lines per file.
- Memories: 30–60 lines per file.

Every H2 section earns its keep or is removed. No placeholders. No "see the linked doc" stubs.

One code block per example. Multiple code blocks in a single section dilute signal.

---

## Cross-cutting conventions

- **Examples are TypeScript** unless the rule is explicitly language-agnostic.
- **Don't repeat across artifacts.** If rule A and rule B overlap, pick one as canonical and `related: [other-id]` from the other.
- **Id uniqueness is per scope.** Cross-scope collisions are the override mechanism; the validator reports them as INFO, not ERROR.
- **Frontmatter `category` is uppercase** for rules (STANDARDS, PROCESS, ...). Skills and memories use lowercase category strings.

---

## Where this fits

After authoring:

1. Run `betterai validate` (the offline path).
2. Commit. For repo-scoped artifacts: `git add .betterai/` and PR like code.
3. For global artifacts: no commit needed; the change is local to your machine.
4. The retrieval server picks the new file up on the next call (file watcher with 5s polling fallback per the v4 design).

For diagnosing why a particular rule did or didn't fire in a session, see [`docs/DEBUGGING.md`](DEBUGGING.md).
