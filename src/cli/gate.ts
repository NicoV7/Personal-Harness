/**
 * betterai gate — Phase 1.0 dogfooding gate (v1.5 Item 4).
 *
 * Verbs:
 *   gate --start    Begin the 5-day dogfooding window: writes
 *                   <BETTERAI_HOME>/gate.json and prints a day-1 checklist
 *                   (audit path writable, corpus validates, server health).
 *                   Refuses with exit 1 if a gate is already in progress.
 *   gate --status   Day N/5 progress: fire count (sessions with >=1 rule
 *                   returned), behavior-change count, pass/fail projection.
 *                   Exit 0 on track / passed, 1 behind, 2 no gate started.
 *   gate --abort    Archive gate.json -> gate.aborted.<ts>.json. Exit 2 if
 *                   no gate is in progress.
 *   gate --week N   (unchanged, per DX-FIX-19) self-verifying weekly
 *                   evaluation over the last 7 days of the audit log.
 *
 * Targets (Phase 1.0): >=5 sessions firing rules x >=5 active days x >=3
 * behavior changes, over a 5-calendar-day window.
 *
 * Behavior-change counting: the audit schema (src/contracts/audit.ts)
 * does not yet define an `apply_compliance` event with `applied_rule_ids`.
 * If such events appear in the log we count them (forward-compatible);
 * otherwise we use a documented proxy — sessions with >=2 retrieve events
 * — and say so in the output.
 *
 * Weekly criteria for --week N (from the v4 design / devex review):
 *   - 5 consecutive days of activity in the audit log
 *   - ≥5 distinct rules fired in the week
 *   - ≥3 visible "behavior changes" (proxied as ≥3 retrieve events where
 *     rules_returned is non-empty AND a code-writing tool was used after)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_MCP_PORT, SCHEMA_VERSION } from "../contracts/env.js";
import { validate } from "./validate.js";

interface AuditEvent {
  event_type: string;
  ts: string;
  rules_returned?: Array<{ id: string }>;
  agent_session_id?: string | null;
  applied_rule_ids?: string[];
}

interface CheckResult {
  name: string;
  pass: boolean;
  observed: string;
  required: string;
}

// ---- Gate targets (named, per STANDARDS: no magic numbers) ---------------

/** The dogfooding window length, in calendar days. */
const GATE_TARGET_DAYS = 5;
/** Distinct sessions that must see >=1 rule returned during the window. */
const GATE_TARGET_SESSIONS = 5;
/** Visible behavior changes required during the window. */
const GATE_TARGET_BEHAVIOR_CHANGES = 3;
/** Best-effort /health probe budget for the day-1 checklist. */
const HEALTH_PROBE_TIMEOUT_MS = 750;
/** Filename of the gate state file inside the BetterAI home dir. */
const GATE_FILENAME = "gate.json";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---- Typed errors ---------------------------------------------------------

/** Thrown by --start when a gate.json already exists. Maps to exit 1. */
export class GateInProgressError extends Error {
  constructor(public readonly gatePath: string, public readonly startedAt: string) {
    super(
      `a dogfooding gate is already in progress (started ${startedAt}, state at ${gatePath}). ` +
        `Run 'betterai gate --status' to inspect it or 'betterai gate --abort' to archive it.`,
    );
    this.name = "GateInProgressError";
  }
}

/** Thrown by --status / --abort when no gate.json exists. Maps to exit 2. */
export class NoGateInProgressError extends Error {
  constructor(public readonly gatePath: string) {
    super(`no dogfooding gate in progress (expected state at ${gatePath}). Run 'betterai gate --start' first.`);
    this.name = "NoGateInProgressError";
  }
}

// ---- State file shape ------------------------------------------------------

interface GateState {
  started_at: string;
  week: number;
  schema_version: string;
}

/**
 * Injectable seams for tests (deterministic clock; no-network health probe).
 * Production callers pass nothing and get the real clock + global fetch.
 */
export interface GateDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface GatePaths {
  globalRoot: string;
  gatePath: string;
  auditPath: string;
}

function resolveGatePaths(): GatePaths {
  // Same resolution chain as the other CLI verbs (status/replay/validate):
  // BETTERAI_HOME env overrides ~/.betterai; BETTERAI_AUDIT_PATH overrides
  // the default audit log location under it.
  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const auditPath = process.env.BETTERAI_AUDIT_PATH ?? join(globalRoot, "audit", "audit.jsonl");
  return { globalRoot, gatePath: join(globalRoot, GATE_FILENAME), auditPath };
}

export async function runGate(args: string[], deps: GateDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());

  if (args.includes("--start")) return gateStart(now, deps.fetchImpl ?? fetch);
  if (args.includes("--status")) return gateStatus(now);
  if (args.includes("--abort")) return gateAbort(now);

  return runWeeklyGate(args);
}

// ---- gate --start ----------------------------------------------------------

async function gateStart(now: () => Date, fetchImpl: typeof fetch): Promise<number> {
  const { globalRoot, gatePath, auditPath } = resolveGatePaths();

  if (existsSync(gatePath)) {
    const startedAt = readGateState(gatePath)?.started_at ?? "<unreadable started_at>";
    const err = new GateInProgressError(gatePath, startedAt);
    process.stderr.write(`gate: ${err.message}\n`);
    return 1;
  }

  const state: GateState = {
    started_at: now().toISOString(),
    week: 1,
    schema_version: SCHEMA_VERSION,
  };
  mkdirSync(globalRoot, { recursive: true });
  writeFileSync(gatePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  process.stdout.write(`\nbetterai gate --start\n${"─".repeat(60)}\n\n`);
  process.stdout.write(`Gate started at ${state.started_at} (state: ${gatePath})\n`);
  process.stdout.write(
    `Targets over ${GATE_TARGET_DAYS} days: >=${GATE_TARGET_SESSIONS} sessions firing rules, ` +
      `>=${GATE_TARGET_BEHAVIOR_CHANGES} behavior changes, >=${GATE_TARGET_DAYS} active days.\n\n`,
  );
  process.stdout.write(`Day-1 checklist:\n`);

  // 1. Audit path writable (creates the file/dirs if missing — same file the
  //    server appends to). Non-fatal: the gate still starts, you just get a
  //    warning to fix before the window burns days.
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    closeSync(openSync(auditPath, "a"));
    process.stdout.write(`  [OK]   audit path writable: ${auditPath}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  [WARN] audit path NOT writable (${auditPath}): ${msg}\n`);
  }

  // 2. Corpus loads with 0 issues (offline schema validation).
  const corpusCode = await validate(globalRoot);
  if (corpusCode === 0) {
    process.stdout.write(`  [OK]   corpus validates with 0 issues: ${globalRoot}\n`);
  } else {
    process.stdout.write(`  [WARN] corpus has validation issues — run 'betterai validate' for details\n`);
  }

  // 3. Server reachable if running — best-effort, non-fatal.
  const port = Number(process.env.BETTERAI_MCP_PORT ?? DEFAULT_MCP_PORT);
  const healthUrl = `http://127.0.0.1:${port}/health`;
  try {
    const res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      process.stdout.write(`  [OK]   server reachable at ${healthUrl}\n`);
    } else {
      process.stdout.write(`  [WARN] server responded ${res.status} at ${healthUrl}\n`);
    }
  } catch {
    process.stdout.write(`  [WARN] server not reachable at ${healthUrl} (fine if not running yet)\n`);
  }

  process.stdout.write(`\nDay 1/${GATE_TARGET_DAYS} begins now. Check progress with 'betterai gate --status'.\n`);
  return 0;
}

// ---- gate --status ---------------------------------------------------------

function gateStatus(now: () => Date): number {
  const { gatePath, auditPath } = resolveGatePaths();
  if (!existsSync(gatePath)) {
    const err = new NoGateInProgressError(gatePath);
    process.stderr.write(`gate: ${err.message}\n`);
    return 2;
  }
  const state = readGateState(gatePath);
  if (!state || typeof state.started_at !== "string" || Number.isNaN(Date.parse(state.started_at))) {
    process.stderr.write(`gate: state file at ${gatePath} is unreadable — abort and restart the gate\n`);
    return 2;
  }

  const startedMs = Date.parse(state.started_at);
  const nowMs = now().getTime();
  // Calendar day N: the day containing started_at is day 1.
  const dayN = Math.max(1, Math.floor((nowMs - startedMs) / MS_PER_DAY) + 1);
  const effectiveDay = Math.min(dayN, GATE_TARGET_DAYS);

  const events = readAuditEvents(auditPath).filter((e) => Date.parse(e.ts) >= startedMs);

  // Fire count: distinct sessions with a retrieve event returning >=1 rule.
  const firingSessions = new Set<string>();
  // Real behavior changes: sessions with an apply_compliance event listing
  // applied_rule_ids (forward-compatible; not yet in the audit schema).
  const applySessions = new Set<string>();
  // Proxy: sessions with >=2 retrieve events.
  const retrievesBySession = new Map<string, number>();
  const activeDays = new Set<string>();

  for (const e of events) {
    activeDays.add(e.ts.slice(0, 10));
    const session = e.agent_session_id ?? null;
    if (session === null) continue;
    if (e.event_type === "retrieve") {
      retrievesBySession.set(session, (retrievesBySession.get(session) ?? 0) + 1);
      if ((e.rules_returned ?? []).length > 0) firingSessions.add(session);
    }
    if (e.event_type === "apply_compliance" && (e.applied_rule_ids ?? []).length > 0) {
      applySessions.add(session);
    }
  }

  const proxySessions = [...retrievesBySession.values()].filter((n) => n >= 2).length;
  const usingProxy = applySessions.size === 0;
  const behaviorChanges = usingProxy ? proxySessions : applySessions.size;
  const behaviorNote = usingProxy
    ? " (proxy: sessions with >=2 retrieve events — apply_compliance events not present in audit log)"
    : " (from apply_compliance events)";

  process.stdout.write(`\nbetterai gate --status\n${"─".repeat(60)}\n\n`);
  process.stdout.write(`Day ${dayN}/${GATE_TARGET_DAYS} (started ${state.started_at})\n\n`);
  process.stdout.write(`  sessions firing rules: ${firingSessions.size} / ${GATE_TARGET_SESSIONS}\n`);
  process.stdout.write(`  behavior changes:      ${behaviorChanges} / ${GATE_TARGET_BEHAVIOR_CHANGES}${behaviorNote}\n`);
  process.stdout.write(`  active days:           ${activeDays.size} / ${GATE_TARGET_DAYS}\n\n`);

  const targetsMet =
    firingSessions.size >= GATE_TARGET_SESSIONS &&
    behaviorChanges >= GATE_TARGET_BEHAVIOR_CHANGES &&
    activeDays.size >= GATE_TARGET_DAYS;

  if (targetsMet) {
    process.stdout.write(`PROJECTION: PASSED — all Phase 1.0 targets met.\n`);
    return 0;
  }

  // Pro-rata projection: by day N you need ceil(target * N / 5) of each.
  const need = (target: number): number => Math.ceil((target * effectiveDay) / GATE_TARGET_DAYS);
  const onTrack =
    firingSessions.size >= need(GATE_TARGET_SESSIONS) &&
    behaviorChanges >= need(GATE_TARGET_BEHAVIOR_CHANGES) &&
    activeDays.size >= Math.min(effectiveDay, GATE_TARGET_DAYS);

  if (dayN > GATE_TARGET_DAYS) {
    process.stdout.write(`PROJECTION: FAILED — window elapsed (day ${dayN}) with targets unmet.\n`);
    return 1;
  }
  if (onTrack) {
    process.stdout.write(
      `PROJECTION: ON TRACK — at or above the day-${effectiveDay} pro-rata pace for every target.\n`,
    );
    return 0;
  }
  process.stdout.write(
    `PROJECTION: BEHIND — below the day-${effectiveDay} pro-rata pace ` +
      `(need >=${need(GATE_TARGET_SESSIONS)} firing sessions, >=${need(GATE_TARGET_BEHAVIOR_CHANGES)} behavior changes by now).\n`,
  );
  return 1;
}

// ---- gate --abort ----------------------------------------------------------

function gateAbort(now: () => Date): number {
  const { gatePath } = resolveGatePaths();
  if (!existsSync(gatePath)) {
    const err = new NoGateInProgressError(gatePath);
    process.stderr.write(`gate: ${err.message}\n`);
    return 2;
  }
  const ts = now().toISOString().replace(/[:.]/g, "-");
  const archived = gatePath.replace(/gate\.json$/, `gate.aborted.${ts}.json`);
  renameSync(gatePath, archived);
  process.stdout.write(`Gate aborted. State archived to ${archived}\n`);
  return 0;
}

// ---- shared helpers --------------------------------------------------------

function readGateState(gatePath: string): GateState | null {
  try {
    return JSON.parse(readFileSync(gatePath, "utf8")) as GateState;
  } catch {
    return null;
  }
}

function readAuditEvents(auditPath: string): AuditEvent[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l: string) => safeParse(l))
    .filter((e): e is AuditEvent => e !== null && typeof e.ts === "string");
}

// ---- gate --week N (unchanged behavior) -------------------------------------

function runWeeklyGate(args: string[]): number {
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

  const { auditPath } = resolveGatePaths();

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
