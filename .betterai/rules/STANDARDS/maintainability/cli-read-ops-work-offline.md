---
id: cli-read-ops-work-offline
title: Read-only CLI verbs must work without the container running
category: STANDARDS
domain: maintainability
severity: medium
created: 2026-06-09
applies_when:
  paths: ["src/cli/**", "bin/betterai*"]
  intents: ["add cli verb", "implement cli", "review pr"]
---

## What this rule says

Read-only `betterai` CLI verbs MUST function with the BetterAI Docker container stopped, by reading the corpus directly from `~/.betterai/` on disk. The verbs that fall under this rule are:

- `betterai validate` — schema-validate the corpus.
- `betterai status --offline` — show corpus counts and last-modified times.
- `betterai why <task> --offline` — show the candidate rule set for an intent, using the in-process router and grep, not the cached server retrieval.

Only verbs that genuinely need live retrieval state (e.g. `betterai status` without `--offline` showing the last server-side override decision, `betterai replay`, `betterai why` in default mode showing what the server actually returned) may require the container.

## Why it matters

The developer authoring loop looks like this: write a rule -> run `betterai validate` -> fix the frontmatter -> run again. If every iteration requires `docker compose up && wait-for-healthy && docker exec ...`, the loop has a five-second tax on a sub-second operation. That tax compounds: the developer stops validating, ships broken frontmatter, the retrieval layer silently drops the rule, and the corpus quietly rots.

There is no architectural reason a schema validator needs the container. The schema lives in code, the corpus lives on disk, and Node can read both. The only reason to route through Docker is laziness or a thin-shim mindset — and the cost of that mindset is paid by every future authoring session.

## When this applies

- Any new CLI verb added under `src/cli/`.
- Any refactor that changes how an existing verb dispatches to the server.
- Any PR that touches the `bin/betterai*` entrypoints.
- Any change to the offline/online split of an existing verb.

## What good looks like

The CLI dispatcher checks whether the requested verb is offline-capable and runs it in-process when so, falling back to the MCP/docker path only when live server state is needed.

```ts
// src/cli/dispatch.ts
import { runValidate } from "./verbs/validate.js";
import { runStatusOffline } from "./verbs/status-offline.js";
import { runWhyOffline } from "./verbs/why-offline.js";
import { execMcp } from "./mcp-client.js";

const OFFLINE_VERBS = {
  validate: runValidate,
  "status:offline": runStatusOffline,
  "why:offline": runWhyOffline,
};

export async function dispatch(verb: string, args: string[]) {
  const offlineKey = args.includes("--offline") ? `${verb}:offline` : verb;
  const offlineHandler = OFFLINE_VERBS[offlineKey] ?? OFFLINE_VERBS[verb];
  if (offlineHandler) {
    return offlineHandler(args);
  }
  return execMcp(verb, args);
}
```

A verb that reads the corpus directly:

```ts
// src/cli/verbs/validate.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFrontmatter } from "../../schema/validate.js";

export function runValidate(): number {
  const root = `${process.env.HOME}/.betterai/rules`;
  const errors: string[] = [];
  for (const file of walkMarkdown(root)) {
    const raw = readFileSync(file, "utf8");
    const result = validateFrontmatter(raw);
    if (!result.ok) errors.push(`${file}: ${result.error}`);
  }
  for (const e of errors) console.error(e);
  return errors.length === 0 ? 0 : 1;
}
```

## Anti-patterns

Wrong — every CLI verb is a thin shim that requires the container:

```ts
// src/cli/verbs/validate.ts
export async function runValidate() {
  return execSync("docker exec betterai betterai-server validate", {
    stdio: "inherit",
  });
}
```

When the container is down, the developer sees `Error: No such container: betterai` and has to context-switch into ops mode just to lint a markdown file.

Wrong — half-offline: the verb tries to read disk first, but on any error (including ENOENT for a missing optional directory) falls through to `docker exec`, so the failure surfaces as a confusing Docker error message instead of a clean "your corpus is empty" report.

Fixed: the offline path is the only path for offline verbs, and it handles its own error cases cleanly.

## Examples

```ts
// CORRECT: a status verb with two modes — offline reads the on-disk
// audit log; default mode hits the MCP server for live override stats.
export async function runStatus(args: string[]) {
  if (args.includes("--offline")) {
    const counts = readCorpusCounts(`${process.env.HOME}/.betterai`);
    console.log(`GLOBAL  ${counts.rules} rules / ${counts.skills} skills`);
    return 0;
  }
  const live = await execMcp("status", []);
  console.log(live.formatted);
  return 0;
}
```
