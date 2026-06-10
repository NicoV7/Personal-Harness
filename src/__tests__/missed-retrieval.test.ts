// G2 — MissedRetrievalDetector tests (docs/RELIABILITY-TEST-GAPS.md).
//
// Lever (b) of the auto-retrieve strategy (eng review §1.6): the detector
// is the v1.0 compliance-detection mechanism — it emits a
// `missed_retrieval` audit event when a code-writing tool (check_file)
// fires without a recent retrieve_* in the SAME agent session.
//
// Sessions are keyed by `agent_session_id` (the per-subagent id threaded
// from the Wave-1 transport: extra.sessionId -> ToolCallMeta.agent_session_id),
// NOT by parent_agent_session_id — so one compliant subagent must never
// mask a sibling's miss under a shared parent.
//
// All time-dependent behavior uses the module's clock-injection seam
// (MissedRetrievalOptions.now) — no real timers, no wall-clock dependence.

import { describe, test, expect } from "vitest";
import { MissedRetrievalDetector } from "../audit/missed-retrieval.js";
import type { ObserveCallInput } from "../audit/missed-retrieval.js";
import type { AuditEvent } from "../audit/jsonl.js";

const RECENCY_MS = 60_000; // module default window
const SESSION_GC_MS = 5 * 60_000; // module's sweep threshold

interface Harness {
  detector: MissedRetrievalDetector;
  events: AuditEvent[];
  /** Advance the injected clock by `ms`. */
  tick: (ms: number) => void;
}

function makeHarness(opts: { recencyMs?: number } = {}): Harness {
  let nowMs = 1_000_000; // arbitrary fixed epoch; tests only use deltas
  const events: AuditEvent[] = [];
  const detector = new MissedRetrievalDetector(e => events.push(e), {
    ...opts,
    now: () => nowMs,
  });
  return {
    detector,
    events,
    tick: ms => {
      nowMs += ms;
    },
  };
}

function makeCall(overrides: Partial<ObserveCallInput> = {}): ObserveCallInput {
  return {
    toolName: "check_file",
    agent_session_id: "sess-a",
    parent_agent_session_id: "parent-1",
    subagent_class: "agent-tool",
    tool_call_id: "call-1",
    context_hash: "hash-abc",
    repo_root_detected: "/repos/example",
    scopes_queried: ["global", "repo"],
    ...overrides,
  };
}

describe("MissedRetrievalDetector — covered sessions", () => {
  test("retrieve followed by check_file within the window emits no missed_retrieval", () => {
    const { detector, events, tick } = makeHarness();

    detector.observe(makeCall({ toolName: "retrieve_context" }));
    tick(30_000); // 30s later, well inside the 60s window
    const result = detector.observe(makeCall({ toolName: "check_file" }));

    expect(result).toEqual({ missed: false });
    expect(events).toHaveLength(0);
  });

  test("check_file exactly at the window boundary is still covered (<= recencyMs)", () => {
    const { detector, events, tick } = makeHarness();

    detector.observe(makeCall({ toolName: "retrieve_context" }));
    tick(RECENCY_MS);
    const result = detector.observe(makeCall({ toolName: "check_file" }));

    expect(result).toEqual({ missed: false });
    expect(events).toHaveLength(0);
  });

  test("retrieval-class tools themselves never count as misses, even with no prior retrieve", () => {
    const { detector, events } = makeHarness();

    for (const toolName of [
      "retrieve_context",
      "retrieve_rules",
      "retrieve_skills",
      "retrieve_memories",
    ]) {
      const result = detector.observe(makeCall({ toolName }));
      expect(result).toEqual({ missed: false });
    }
    expect(events).toHaveLength(0);
  });

  test("tools that neither retrieve nor write code are ignored", () => {
    const { detector, events } = makeHarness();

    const result = detector.observe(makeCall({ toolName: "explain_rule" }));

    expect(result).toEqual({ missed: false });
    expect(events).toHaveLength(0);
  });
});

describe("MissedRetrievalDetector — missed retrieval emission", () => {
  test("check_file with no prior retrieve emits a missed_retrieval event with the full envelope", () => {
    const { detector, events } = makeHarness();

    const result = detector.observe(
      makeCall({
        toolName: "check_file",
        agent_session_id: "sess-orphan",
        parent_agent_session_id: "parent-42",
        subagent_class: "workflow",
        tool_call_id: "call-77",
        context_hash: "hash-orphan",
      }),
    );

    expect(result).toEqual({ missed: true });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.event_type).toBe("missed_retrieval");
    expect(event.agent_session_id).toBe("sess-orphan");
    expect(event.parent_agent_session_id).toBe("parent-42");
    expect(event.subagent_class).toBe("workflow");
    expect(event.tool_call_id).toBe("call-77");
    expect(event.context_hash).toBe("hash-orphan");
    expect(event.repo_root_detected).toBe("/repos/example");
    expect(event.scopes_queried).toEqual(["global", "repo"]);
    expect(event.rules_returned).toEqual([]);
    expect(event.overridden_global_ids).toEqual([]);
    expect(event.latency_ms).toBe(0);
    expect(event.downstream_apply_event_id).toBeNull();
    expect(event.downstream_commit_sha).toBeNull();
    expect(event.downstream_violations).toBeNull();
    // ts comes from the injected clock, not wall time
    expect(event.ts).toBe(new Date(1_000_000).toISOString());
  });

  test("retrieve followed by check_file after the window elapses emits missed_retrieval", () => {
    const { detector, events, tick } = makeHarness();

    detector.observe(makeCall({ toolName: "retrieve_context" }));
    tick(RECENCY_MS + 1); // one ms past the window
    const result = detector.observe(makeCall({ toolName: "check_file" }));

    expect(result).toEqual({ missed: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("missed_retrieval");
  });

  test("a fresh retrieve after a miss re-covers the session", () => {
    const { detector, events, tick } = makeHarness();

    detector.observe(makeCall({ toolName: "check_file" })); // miss #1
    detector.observe(makeCall({ toolName: "retrieve_context" }));
    tick(10_000);
    const result = detector.observe(makeCall({ toolName: "check_file" }));

    expect(result).toEqual({ missed: false });
    expect(events).toHaveLength(1); // only the first miss
  });
});

describe("MissedRetrievalDetector — per-session independence", () => {
  test("two subagents under one parent are tracked by their own agent_session_id; a compliant sibling does not mask the other's miss", () => {
    // Keying contract: extra.sessionId -> ToolCallMeta.agent_session_id is
    // the map key. parent_agent_session_id is envelope metadata only.
    const { detector, events, tick } = makeHarness();
    const parent = "parent-shared";

    // Subagent A retrieves, then writes — fully compliant.
    detector.observe(
      makeCall({
        toolName: "retrieve_context",
        agent_session_id: "sess-a",
        parent_agent_session_id: parent,
      }),
    );
    tick(1_000);
    const aResult = detector.observe(
      makeCall({
        toolName: "check_file",
        agent_session_id: "sess-a",
        parent_agent_session_id: parent,
      }),
    );

    // Subagent B (same parent) writes WITHOUT retrieving.
    const bResult = detector.observe(
      makeCall({
        toolName: "check_file",
        agent_session_id: "sess-b",
        parent_agent_session_id: parent,
        tool_call_id: "call-b",
      }),
    );

    expect(aResult).toEqual({ missed: false });
    expect(bResult).toEqual({ missed: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.agent_session_id).toBe("sess-b");
    expect(events[0]!.parent_agent_session_id).toBe(parent);
    expect(events[0]!.tool_call_id).toBe("call-b");
  });

  test("a null agent_session_id is tracked under its own sentinel bucket, independent of named sessions", () => {
    const { detector, events } = makeHarness();

    detector.observe(
      makeCall({ toolName: "retrieve_context", agent_session_id: "sess-a" }),
    );
    const result = detector.observe(
      makeCall({ toolName: "check_file", agent_session_id: null }),
    );

    expect(result).toEqual({ missed: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.agent_session_id).toBeNull();
  });
});

describe("MissedRetrievalDetector — sweep/GC behavior", () => {
  /** Peek at the private session map purely to assert GC bookkeeping. */
  function sessionKeys(detector: MissedRetrievalDetector): string[] {
    const internal = detector as unknown as {
      sessions: Map<string, unknown>;
    };
    return [...internal.sessions.keys()];
  }

  test("sessions idle past the GC window are swept; fresh sessions survive", () => {
    const { detector, tick } = makeHarness();

    detector.observe(
      makeCall({ toolName: "retrieve_context", agent_session_id: "sess-old" }),
    );
    expect(sessionKeys(detector)).toEqual(["sess-old"]);

    tick(SESSION_GC_MS + 1);
    // Any observe() triggers the sweep before processing the call.
    detector.observe(
      makeCall({ toolName: "retrieve_context", agent_session_id: "sess-new" }),
    );

    expect(sessionKeys(detector)).toEqual(["sess-new"]);
  });

  test("sessions still within the GC window are NOT swept", () => {
    const { detector, tick } = makeHarness();

    detector.observe(
      makeCall({ toolName: "retrieve_context", agent_session_id: "sess-old" }),
    );
    tick(SESSION_GC_MS - 1);
    detector.observe(
      makeCall({ toolName: "retrieve_context", agent_session_id: "sess-new" }),
    );

    expect(sessionKeys(detector).sort()).toEqual(["sess-new", "sess-old"]);
  });

  test("GC never sweeps a session that is still covered when recencyMs exceeds the GC floor", () => {
    // Regression guard: the module header promises "we GC sessions older
    // than the recency window". With a configured recencyMs LONGER than
    // the 5-minute GC floor, a still-covered session must not be swept —
    // otherwise the detector emits a FALSE missed_retrieval.
    const TEN_MINUTES = 10 * 60_000;
    const { detector, events, tick } = makeHarness({ recencyMs: TEN_MINUTES });

    detector.observe(makeCall({ toolName: "retrieve_context" }));
    tick(6 * 60_000); // past the 5-min GC floor, inside the 10-min window
    const result = detector.observe(makeCall({ toolName: "check_file" }));

    expect(result).toEqual({ missed: false });
    expect(events).toHaveLength(0);
  });
});
