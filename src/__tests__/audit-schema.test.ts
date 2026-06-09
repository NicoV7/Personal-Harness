// Audit-schema test per the SHARED CONTRACT in this slice. The locked
// invariant from .betterai/rules/STANDARDS/observability/audit-must-include-parent-session.md
// is: subagent_class != "main" REQUIRES a non-null parent_agent_session_id.
// Anything else is a silent breakage in the downstream replay analyzer.
//
// The validator lives in _meta-validators/rule-schema.ts so the offline CLI
// can reuse it without spinning up the server.

import { describe, test, expect } from "vitest";
import { validateAuditEvent } from "../_meta-validators/rule-schema.js";

function baseEvent() {
  return {
    event_type: "retrieve",
    ts: "2026-06-09T14:13:23.456Z",
    agent_session_id: "claude-code:session-xyz",
    parent_agent_session_id: null,
    subagent_class: "main",
    tool_call_id: "tool_42",
    context_hash: "sha256:abc",
    repo_root_detected: null,
    scopes_queried: ["global"],
    rules_returned: [],
    overridden_global_ids: [],
    latency_ms: 17,
    downstream_apply_event_id: null,
    downstream_commit_sha: null,
    downstream_violations: null,
  };
}

describe("audit-schema parent_agent_session_id invariant", () => {
  test("the main-loop event is allowed to omit parent_agent_session_id", () => {
    const r = validateAuditEvent(baseEvent());
    expect(r.ok).toBe(true);
  });

  test("an agent-tool subagent event without parent_agent_session_id is rejected", () => {
    const e = { ...baseEvent(), subagent_class: "agent-tool", parent_agent_session_id: null };
    const r = validateAuditEvent(e);
    expect(r.ok).toBe(false);
    expect(r.errors.find(x => x.code === "AUDIT_MISSING_PARENT")).toBeTruthy();
  });

  test("a workflow subagent event without parent_agent_session_id is rejected", () => {
    const e = { ...baseEvent(), subagent_class: "workflow", parent_agent_session_id: null };
    const r = validateAuditEvent(e);
    expect(r.ok).toBe(false);
  });

  test("a background subagent event with a populated parent_agent_session_id is accepted", () => {
    const e = {
      ...baseEvent(),
      subagent_class: "background",
      parent_agent_session_id: "claude-code:parent-1",
    };
    const r = validateAuditEvent(e);
    expect(r.ok).toBe(true);
  });

  test("a cron-class event without parent_agent_session_id is rejected even when no human session is active", () => {
    const e = { ...baseEvent(), subagent_class: "cron", parent_agent_session_id: null };
    const r = validateAuditEvent(e);
    expect(r.ok).toBe(false);
  });
});
