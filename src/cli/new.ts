/**
 * betterai new {rule|skill|memory} [--scope repo|global]
 *
 * Scaffolds a new artifact with frontmatter pre-stubbed per the v4.1
 * scoping design.
 *
 * Default scope:
 *   - 'repo' if CWD is inside a git repo (we autodetect and scaffold
 *     <repo-root>/.betterai/ on first call if it doesn't exist)
 *   - 'global' otherwise
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { detectRepoRoot } from "./_shared/repo-root.js";

type Kind = "rule" | "skill" | "memory";

export function runNew(args: string[]): number {
  const kindArg = args[0];
  if (kindArg !== "rule" && kindArg !== "skill" && kindArg !== "memory") {
    process.stderr.write(`new: first argument must be 'rule', 'skill', or 'memory'\n`);
    return 2;
  }
  const kind: Kind = kindArg;

  let scope: "repo" | "global" | null = null;
  let title = "";
  let id = "";
  let category = "";
  let domain = "";
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--scope") {
      const v = args[++i];
      if (v !== "repo" && v !== "global") {
        process.stderr.write(`new: --scope expects 'repo' or 'global', got '${v}'\n`);
        return 2;
      }
      scope = v;
    } else if (a === "--title") {
      title = args[++i] ?? "";
    } else if (a === "--id") {
      id = args[++i] ?? "";
    } else if (a === "--category") {
      category = args[++i] ?? "";
    } else if (a === "--domain") {
      domain = args[++i] ?? "";
    } else {
      process.stderr.write(`new: ignoring unknown flag '${a}'\n`);
    }
  }

  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const repoRoot = detectRepoRoot(process.cwd());

  if (scope === null) {
    // Default per the v4.1 scoping doc §authoring repo-scoped artifact: repo
    // when CWD is in a repo, else global.
    scope = repoRoot ? "repo" : "global";
  }
  if (scope === "repo" && !repoRoot) {
    process.stderr.write(`new --scope repo: no git repo detected at ${process.cwd()}\n`);
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const resolvedId = id || `new-${kind}-${today}`;
  const resolvedTitle = title || `New ${kind}`;
  const resolvedCategory =
    category || (kind === "rule" ? "STANDARDS" : kind === "skill" ? "corpus-management" : "");
  const resolvedDomain = domain || "maintainability";

  const root = scope === "repo" ? join(repoRoot!, ".betterai") : globalRoot;
  const targetPath = pathForArtifact(root, kind, resolvedCategory, resolvedDomain, resolvedId, today);
  if (existsSync(targetPath)) {
    process.stderr.write(`new: ${targetPath} already exists; refusing to overwrite\n`);
    return 1;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, stubFor(kind, scope, resolvedId, resolvedTitle, resolvedCategory, resolvedDomain, today));

  process.stdout.write(`new: created ${targetPath}\n`);
  process.stdout.write(`     scope: ${scope}\n`);
  process.stdout.write(`     next:  edit the file, then 'betterai validate'\n`);
  return 0;
}

function pathForArtifact(
  root: string,
  kind: Kind,
  category: string,
  domain: string,
  id: string,
  today: string,
): string {
  if (kind === "rule") return join(root, "rules", category, domain, `${id}.md`);
  if (kind === "skill") return join(root, "skills", category, `${id}.md`);
  // memory
  return join(root, "memories", today.slice(0, 7), `${id}.md`);
}

function stubFor(
  kind: Kind,
  scope: "repo" | "global",
  id: string,
  title: string,
  category: string,
  domain: string,
  today: string,
): string {
  if (kind === "rule") {
    return `---
id: ${id}
title: ${title}
category: ${category}
domain: ${domain}
severity: medium
created: ${today}
applies_when:
  paths: ["**/*.ts"]
  intents: []
---

## What this rule says

(One-paragraph statement of the constraint. Scope: ${scope.toUpperCase()}.)

## Why it matters

(The cost of violating it.)

## When this applies

(Concrete trigger conditions.)

## What good looks like

\`\`\`ts
// concrete TypeScript example of compliance
\`\`\`

## Anti-patterns

Wrong:

\`\`\`ts
// concrete TypeScript example of violation
\`\`\`

Fixed: see "What good looks like".

## Examples

(Optional. One TypeScript code block per example.)
`;
  }
  if (kind === "skill") {
    return `---
id: ${id}
title: ${title}
category: ${category}
when_to_use: |
  (Multi-line description of when an agent should pull this skill into context.)
steps_count: 5
created: ${today}
---

## When to use this skill

(One-paragraph description.)

## Prerequisites

- (Bullet)

## Steps

1. (Step one)
2. (Step two)
3. (Step three)
4. (Step four)
5. (Step five)

## What good looks like

(Concrete output / artifact shape.)

## Common failure modes

- (Bullet)

## Related rules

- (Rule id)
`;
  }
  // memory
  return `---
id: ${id}
title: ${title}
date: ${today}
project: betterai
kind: decision
context_keywords: []
durability: medium
auto_captured: false
applies_to_future_intents: []
related_rules: []
---

## What happened

(One-paragraph factual recap of the episode. Scope: ${scope.toUpperCase()}.)

## Why it matters (for future me)

(The reason a future agent should know this.)

## Don't relitigate

(Explicit assertion that future-agent should not re-open this territory.)
`;
}
