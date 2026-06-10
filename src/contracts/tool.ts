// src/contracts/tool.ts
//
// SHARED CONTRACT — MCP tool surface (schema_version 1.5).
//
// Mirrors the LIVE shapes in src/app.ts (McpTool, ToolCallMeta)
// and src/retrieval/index.ts (OrchestratorMeta). Drift guards at
// the bottom fail `npm run typecheck` on any divergence.
//
// Standards that bind every tool implementation (see .betterai/rules/):
//   - HTTP/SSE transport ONLY — never stdio
//     (STANDARDS/maintainability/no-stdio-mcp-transport.md).
//   - Bearer auth on every tool; /health is the only bypass
//     (STANDARDS/security/mcp-tools-require-bearer.md).
//   - subagent_class != "main" requires non-null parent_agent_session_id
//     (STANDARDS/observability/audit-must-include-parent-session.md).

import type { SubagentClass } from "./audit.js";
import type { AssertTrue, MutuallyAssignable } from "./audit.js";

// ToolContext stays defined in src/app.ts for now — it is the DI
// bag of concrete server classes (CorpusReader, ContextCache, ...), so it
// gets contract-ified only when those classes grow interfaces in a later
// wave. Re-exported type-only so contract consumers have a single import
// surface today and the later flip is a one-line change.
export type { ToolContext } from "../app.js";
import type { ToolContext } from "../app.js";

// ---- Per-call metadata ----------------------------------------------------

/**
 * Identity envelope threaded into every tool handler as the third
 * argument. Extracted from the MCP call's `_meta` by the server bridge;
 * handlers never parse transport frames themselves.
 */
export interface ToolCallMeta {
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: SubagentClass | null;
  tool_call_id: string;
}

/**
 * The same identity envelope as seen by the retrieval orchestrator.
 * Structurally identical to ToolCallMeta — tools pass their meta through
 * unchanged.
 */
export interface OrchestratorMeta {
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: SubagentClass | null;
  tool_call_id: string;
}

// ---- The MCP tool contract ------------------------------------------------

/**
 * Framework-agnostic tool definition. Tools export one of these from
 * src/mcp-tools/<name>.ts; src/index.ts collects them and hands them to
 * `startServer({ tools })` — the DI direction is server → tools, never
 * tools → server.
 */
export interface McpTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** JSON-schema-shaped input declaration handed to the MCP SDK. */
  inputSchema: Record<string, unknown>;
  handler: (input: I, ctx: ToolContext, meta: ToolCallMeta) => Promise<O>;
}

// ---- Drift guards (typecheck-time; zero runtime cost) ---------------------

import type {
  McpTool as LiveMcpTool,
  ToolCallMeta as LiveToolCallMeta,
} from "../app.js";
import type { OrchestratorMeta as LiveOrchestratorMeta } from "../retrieval/index.js";

export type ToolContractDriftChecks = [
  AssertTrue<MutuallyAssignable<ToolCallMeta, LiveToolCallMeta>>,
  AssertTrue<MutuallyAssignable<OrchestratorMeta, LiveOrchestratorMeta>>,
  AssertTrue<MutuallyAssignable<McpTool, LiveMcpTool>>,
  AssertTrue<
    MutuallyAssignable<
      McpTool<{ intent: string }, { ok: boolean }>,
      LiveMcpTool<{ intent: string }, { ok: boolean }>
    >
  >,
];
