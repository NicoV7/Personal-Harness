/**
 * betterai gate --week N
 *
 * Per DX-FIX-19: self-verifying Phase 1.0 dogfooding gate.
 *
 * Criteria (from the v4 design / devex review):
 *   - 5 consecutive days of activity in the audit log
 *   - ≥5 distinct rules fired in the week
 *   - ≥3 visible "behavior changes" (proxied as ≥3 retrieve events where
 *     rules_returned is non-empty AND a code-writing tool was used after)
 *
 * Outputs PASS / FAIL with the supporting numbers so the result is
 * legible and re-runnable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface AuditEvent {
  event_type: string;
  ts: string;
  rules_returned?: Array<{ id: string }>;
  agent_session_id?: string | null;
}

interface CheckResult {
  name: string;
  pass: boolean;
  observed: string;
  required: string;
}

export function runGate(args: string[]): number {
  let week = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--week") {
      week = Number(args[++i]);
      if (!Number.isFinite(week) || week < 1) {
        process.stderr.write(`gate: --week expects a positive integer\n`);
        return 2;
      }
    }
  }

  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const auditPath = process.env.BETTERAI_AUDIT_PATH ?? join(globalRoot, "audit", "audit.jsonl");

  process.stdout.write(`\nbetterai gate --week ${week}\n${"─".repeat(60)}\n\n`);

  if (!existsSync(auditPath)) {
    process.stdout.write(`FAIL: no audit log at ${auditPath}\n`);
    process.stdout.write(`      The gate measures dogfooding from the audit log; with no log\n`);
    process.stdout.write(`      there is nothing to measure. Use BetterAI for a week, then re-run.\n`);
    return 1;
  }

  // Window: the most recent 7-day period (week N is informational, used in the
  // header — we always evaluate "the last 7 days of activity in the log",
  // which is the only honest measurement).
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - windowMs;

  const events = readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l: string) => safeParse(l))
    .filter((e): e is AuditEvent => e !== null)
    .filter((e) => Date.parse(e.ts) >= cutoff);

  const distinctDays = new Set<string>();
  const distinctRules = new Set<string>();
  let behaviorChanges = 0;
  let priorWasRetrieve = false;
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    distinctDays.add(day);
    for (const r of e.rules_returned ?? []) distinctRules.add(r.id);
    if (priorWasRetrieve && /^(agent_apply|code_write|edit|write)$/.test(e.event_type)) {
      behaviorChanges++;
      priorWasRetrieve = false;
    }
    if (e.event_type === "retrieve" && (e.rules_returned ?? []).length > 0) {
      priorWasRetrieve = true;
    }
  }

  // Approximate "5 consecutive days" — accept any 5 days touching the window.
  const consecutive = countConsecutive([...distinctDays].sort());

  const checks: CheckResult[] = [
    {
      name: "5 consecutive days of activity",
      pass: consecutive >= 5,
      observed: `${consecutive} consecutive days (across ${distinctDays.size} total active day(s))`,
      required: "≥5 consecutive days",
    },
    {
      name: "≥5 distinct rules fired",
      pass: distinctRules.size >= 5,
      observed: `${distinctRules.size} distinct rule(s) fired`,
      required: "≥5 distinct rules",
    },
    {
      name: "≥3 visible behavior changes",
      pass: behaviorChanges >= 3,
      observed: `${behaviorChanges} retrieve→apply chain(s)`,
      required: "≥3 retrieve→apply chains",
    },
  ];

  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL";
    process.stdout.write(`  [${tag}] ${c.name}\n         observed: ${c.observed}\n         required: ${c.required}\n\n`);
  }

  const allPass = checks.every((c) => c.pass);
  if (allPass) {
    process.stdout.write(`OVERALL: PASS — Phase 1.0 dogfooding gate (week ${week}) clears.\n`);
    return 0;
  }
  process.stdout.write(`OVERALL: FAIL — see failing check(s) above.\n`);
  return 1;
}

function safeParse(line: string): AuditEvent | null {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return null;
  }
}

function countConsecutive(sortedDays: string[]): number {
  // Longest run of consecutive calendar days in the sorted list.
  if (sortedDays.length === 0) return 0;
  let best = 1;
  let run = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const prev = Date.parse(sortedDays[i - 1] + "T00:00:00Z");
    const curr = Date.parse(sortedDays[i] + "T00:00:00Z");
    const diffDays = Math.round((curr - prev) / (24 * 60 * 60 * 1000));
    if (diffDays === 1) {
      run++;
      if (run > best) best = run;
    } else if (diffDays > 1) {
      run = 1;
    }
  }
  return best;
}
