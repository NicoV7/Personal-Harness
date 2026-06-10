#!/usr/bin/env node
/**
 * betterai CLI entrypoint.
 *
 * Commander-style dispatcher. Each verb is a separate module under src/cli/.
 * Read-only verbs (validate, status --offline, why --offline) run in-process
 * against ~/.betterai/ without requiring the container to be up — see
 * .betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md.
 *
 * Verbs:
 *   init       — scaffold ~/.betterai/ + seed corpus + welcome task
 *   validate   — schema-validate global + repo corpora (offline)
 *   status     — show global + repo counts and recent audit activity
 *   why        — simulate retrieve_context against a hand-given context
 *   replay     — weekly audit-log digest
 *   gate       — self-verifying Phase 1.0 dogfooding gate
 *   new        — scaffolder for new rule|skill|memory artifacts
 */
import { runInit } from "./init.js";
import { runValidate } from "./validate.js";
import { runStatus } from "./status.js";
import { runWhy } from "./why.js";
import { runReplay } from "./replay.js";
import { runGate } from "./gate.js";
import { runNew } from "./new.js";

type VerbHandler = (args: string[]) => Promise<number> | number;

const VERBS: Record<string, VerbHandler> = {
  init: runInit,
  validate: runValidate,
  status: runStatus,
  why: runWhy,
  replay: runReplay,
  gate: runGate,
  new: runNew,
};

const HELP = `betterai — local context moat CLI

USAGE
  betterai <verb> [options]

VERBS
  init [--seed]              Scaffold ~/.betterai/ and (optionally) seed corpus + welcome task
  validate                   Schema-validate the global and repo corpora (offline-safe)
  status [--offline]         Show corpus counts and recent activity
  why <task> [--context P]   Explain routing decision for a task description
  replay --since 7d          Weekly audit-log digest
  gate --start               Begin the 5-day Phase 1.0 dogfooding gate (writes gate.json)
  gate --status              Day N/5 progress vs gate targets (exit 2 if no gate started)
  gate --abort               Archive the in-progress gate (gate.aborted.<ts>.json)
  gate --week N              Self-verifying weekly dogfooding-gate evaluation
  new {rule|skill|memory}    Scaffold a new artifact (--scope repo|global)

  -h, --help                 Show this help
  -v, --version              Show version

EXAMPLES
  betterai init --seed
  betterai validate
  betterai status --offline
  betterai why "refactor the stripe webhook handler"
  betterai new rule --scope repo
`;

const VERSION = "1.0.0";

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "-v" || args[0] === "--version") {
    process.stdout.write(`betterai ${VERSION}\n`);
    return 0;
  }
  const verb = args[0];
  const handler = VERBS[verb];
  if (!handler) {
    process.stderr.write(`betterai: unknown verb '${verb}'\n\n${HELP}`);
    return 2;
  }
  try {
    const code = await handler(args.slice(1));
    return typeof code === "number" ? code : 0;
  } catch (err) {
    // We deliberately do NOT swallow the error type — per
    // STANDARDS/error-handling/no-catch-all-exception-masking we log
    // with context and re-surface a non-zero exit code.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`betterai ${verb}: ${msg}\n`);
    if (process.env.BETTERAI_LOG_LEVEL === "debug" && err instanceof Error) {
      process.stderr.write(`${err.stack}\n`);
    }
    return 1;
  }
}

// Direct execution (not import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code));
}
