// src/contracts/index.ts
//
// SHARED CONTRACTS BARREL (schema_version 1.5).
//
// Every wave specialist imports agreed shapes from here — never from
// each other's prompts and never by re-declaring them locally. This is
// the structural fix for the Wave-3 contract-drift failure mode
// (docs/HANDOFF.md §"What NOT to do", last bullet).
//
// Module map:
//   ./audit      AuditEvent envelope + enums (Zod + inferred types)
//   ./retrieval  MatchContext / ScoredArtifact / Retrieve I/O +
//                the RetrievalScorer seam for Phase-1.5 embeddings
//   ./tool       McpTool / ToolCallMeta / OrchestratorMeta
//   ./env        Env Zod schema (existing + v1.5 vars) + SCHEMA_VERSION
//
// Each module carries its own typecheck-time drift guards against the
// live server types; src/__tests__/contracts-drift.test.ts adds runtime
// Zod smoke tests.

export * from "./audit.js";
export * from "./retrieval.js";
export * from "./tool.js";
export * from "./env.js";
