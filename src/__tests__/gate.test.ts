// Tests for the Phase 1.0 dogfooding gate CLI verbs (v1.5 Item 4):
//
//   betterai gate --start | --status | --abort | --week N
//
// Drives runGate() programmatically (same pattern as cli-offline.test.ts):
// tmpdir BETTERAI_HOME, fixture audit JSONL, injected clock and fetch —
// fully deterministic, no server, no docker, no network.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../cli/gate.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fixed "now" so day-counting assertions never depend on wall-clock. */
const NOW = new Date("2026-06-10T12:00:00.000Z");

/** Deterministic deps: frozen clock + a fetch that always refuses. */
const deps = {
  now: () => NOW,
  fetchImpl: (async () => {
    throw new Error("ECONNREFUSED (test stub — no network allowed)");
  }) as unknown as typeof fetch,
};

let home: string;
let auditPath: string;
const savedEnv: Record<string, string | undefined> = {};
let out: string[];
let errOut: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function auditEvent(overrides: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    event_type: "retrieve",
    ts: NOW.toISOString(),
    agent_session_id: "s-default",
    rules_returned: [],
    ...overrides,
  });
}

function writeAudit(lines: string[]): void {
  mkdirSync(join(home, "audit"), { recursive: true });
  writeFileSync(auditPath, lines.join("\n") + "\n", "utf8");
}

function writeGateState(startedAt: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "gate.json"),
    JSON.stringify({ started_at: startedAt, week: 1, schema_version: "1.5" }),
    "utf8",
  );
}

function stdoutText(): string {
  return out.join("");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "betterai-gate-"));
  auditPath = join(home, "audit", "audit.jsonl");
  for (const k of ["BETTERAI_HOME", "BETTERAI_AUDIT_PATH", "BETTERAI_MCP_PORT"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.BETTERAI_HOME = home;
  delete process.env.BETTERAI_AUDIT_PATH; // derive from BETTERAI_HOME
  out = [];
  errOut = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    errOut.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("gate --start", () => {
  test("writes gate.json with started_at, week 1, schema_version and prints the checklist", async () => {
    const code = await runGate(["--start"], deps);
    expect(code).toBe(0);

    const gatePath = join(home, "gate.json");
    expect(existsSync(gatePath)).toBe(true);
    const state = JSON.parse(readFileSync(gatePath, "utf8"));
    expect(state.started_at).toBe(NOW.toISOString());
    expect(state.week).toBe(1);
    expect(typeof state.schema_version).toBe("string");
    expect(state.schema_version.length).toBeGreaterThan(0);

    const text = stdoutText();
    expect(text).toContain("audit path writable");
    expect(text).toContain("corpus validates with 0 issues");
    // Server probe is best-effort: stub fetch refuses, so we get a WARN, not a failure.
    expect(text).toContain("[WARN] server not reachable");
    // The audit-writable check creates the file so day 1 can log immediately.
    expect(existsSync(auditPath)).toBe(true);
  });

  test("refuses with exit 1 if a gate is already in progress", async () => {
    expect(await runGate(["--start"], deps)).toBe(0);
    out = [];
    errOut = [];
    const code = await runGate(["--start"], deps);
    expect(code).toBe(1);
    expect(errOut.join("")).toContain("already in progress");
  });
});

describe("gate --status", () => {
  test("exits 2 when no gate has been started", async () => {
    const code = await runGate(["--status"], deps);
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("no dogfooding gate in progress");
  });

  test("counts calendar days since started_at (day N/5)", async () => {
    // Started 3 full days before NOW -> we are on day 4.
    writeGateState(new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString());
    const code = await runGate(["--status"], deps);
    expect(stdoutText()).toContain("Day 4/5");
    // Day 4 with zero activity is BEHIND -> exit 1.
    expect(code).toBe(1);
  });

  test("fire count = distinct sessions with a retrieve event returning >=1 rule", async () => {
    writeGateState(new Date(NOW.getTime() - 1 * MS_PER_DAY).toISOString());
    writeAudit([
      // s1 fires (one retrieve with rules).
      auditEvent({ agent_session_id: "s1", rules_returned: [{ id: "rule-a" }] }),
      // s2 retrieves but gets nothing back: not a fire.
      auditEvent({ agent_session_id: "s2", rules_returned: [] }),
      // s3 fires twice — still one session.
      auditEvent({ agent_session_id: "s3", rules_returned: [{ id: "rule-b" }] }),
      auditEvent({ agent_session_id: "s3", rules_returned: [{ id: "rule-c" }] }),
      // Null session is ignored for session-keyed counts.
      auditEvent({ agent_session_id: null, rules_returned: [{ id: "rule-d" }] }),
      // Event from before the gate window is excluded.
      auditEvent({
        agent_session_id: "s9",
        rules_returned: [{ id: "rule-e" }],
        ts: new Date(NOW.getTime() - 10 * MS_PER_DAY).toISOString(),
      }),
    ]);
    await runGate(["--status"], deps);
    expect(stdoutText()).toContain("sessions firing rules: 2 / 5");
  });

  test("behavior changes use the documented >=2-retrieves proxy and note it", async () => {
    writeGateState(NOW.toISOString());
    writeAudit([
      auditEvent({ agent_session_id: "s1", rules_returned: [{ id: "rule-a" }] }),
      auditEvent({ agent_session_id: "s1", rules_returned: [] }),
      auditEvent({ agent_session_id: "s2", rules_returned: [{ id: "rule-b" }] }),
    ]);
    await runGate(["--status"], deps);
    const text = stdoutText();
    expect(text).toContain("behavior changes:      1 / 3");
    expect(text).toContain("proxy: sessions with >=2 retrieve events");
  });

  test("prefers real apply_compliance events over the proxy when present", async () => {
    writeGateState(NOW.toISOString());
    writeAudit([
      auditEvent({ agent_session_id: "s1", rules_returned: [{ id: "rule-a" }] }),
      auditEvent({
        agent_session_id: "s1",
        event_type: "apply_compliance",
        applied_rule_ids: ["rule-a"],
      }),
    ]);
    await runGate(["--status"], deps);
    const text = stdoutText();
    expect(text).toContain("behavior changes:      1 / 3 (from apply_compliance events)");
    expect(text).not.toContain("proxy:");
  });

  test("reports PASSED with exit 0 once all targets are met", async () => {
    writeGateState(new Date(NOW.getTime() - 4 * MS_PER_DAY).toISOString());
    const lines: string[] = [];
    // 5 sessions firing across 5 distinct days, each with 2 retrieves (proxy
    // behavior changes = 5 >= 3).
    for (let d = 0; d < 5; d++) {
      const ts = new Date(NOW.getTime() - (4 - d) * MS_PER_DAY).toISOString();
      lines.push(auditEvent({ agent_session_id: `s${d}`, rules_returned: [{ id: `rule-${d}` }], ts }));
      lines.push(auditEvent({ agent_session_id: `s${d}`, rules_returned: [], ts }));
    }
    writeAudit(lines);
    const code = await runGate(["--status"], deps);
    expect(stdoutText()).toContain("PROJECTION: PASSED");
    expect(code).toBe(0);
  });

  test("day 1 with one firing session is ON TRACK (exit 0)", async () => {
    writeGateState(NOW.toISOString());
    writeAudit([
      auditEvent({ agent_session_id: "s1", rules_returned: [{ id: "rule-a" }] }),
      auditEvent({ agent_session_id: "s1", rules_returned: [{ id: "rule-b" }] }),
    ]);
    const code = await runGate(["--status"], deps);
    expect(stdoutText()).toContain("PROJECTION: ON TRACK");
    expect(code).toBe(0);
  });
});

describe("gate --abort", () => {
  test("archives gate.json to gate.aborted.<ts>.json and exits 0", async () => {
    writeGateState(NOW.toISOString());
    const code = await runGate(["--abort"], deps);
    expect(code).toBe(0);
    expect(existsSync(join(home, "gate.json"))).toBe(false);
    const archived = readdirSync(home).filter((f) => /^gate\.aborted\..+\.json$/.test(f));
    expect(archived).toHaveLength(1);
    expect(stdoutText()).toContain("Gate aborted");
    // A new gate can start immediately after an abort.
    expect(await runGate(["--start"], deps)).toBe(0);
  });

  test("exits 2 when no gate is in progress", async () => {
    const code = await runGate(["--abort"], deps);
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("no dogfooding gate in progress");
  });
});

describe("gate --week N (regression: unchanged behavior)", () => {
  test("passes against a 5-consecutive-day, 5-rule, 3-chain audit fixture", async () => {
    // The weekly gate evaluates the last 7 days against the REAL clock, so
    // the fixture is generated relative to Date.now().
    const realNow = Date.now();
    const lines: string[] = [];
    for (let d = 4; d >= 0; d--) {
      const base = realNow - d * MS_PER_DAY;
      lines.push(
        auditEvent({
          agent_session_id: `wk-s${d}`,
          rules_returned: [{ id: `wk-rule-${d}` }],
          ts: new Date(base).toISOString(),
        }),
      );
      lines.push(
        auditEvent({
          event_type: "agent_apply",
          agent_session_id: `wk-s${d}`,
          ts: new Date(base + 60_000).toISOString(),
        }),
      );
    }
    writeAudit(lines);
    const code = await runGate(["--week", "1"], deps);
    const text = stdoutText();
    expect(text).toContain("betterai gate --week 1");
    expect(text).toContain("OVERALL: PASS");
    expect(code).toBe(0);
  });

  test("fails with exit 1 when there is no audit log", async () => {
    const code = await runGate(["--week", "1"], deps);
    expect(stdoutText()).toContain("FAIL: no audit log");
    expect(code).toBe(1);
  });

  test("rejects a non-positive --week with exit 2", async () => {
    const code = await runGate(["--week", "0"], deps);
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("--week expects a positive integer");
  });
});
