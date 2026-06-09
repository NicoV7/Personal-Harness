// src/server/main.ts
//
// Hono app + MCP SDK registration + tool registration via dependency
// injection.
//
// Lifecycle:
//   1. read env vars (Zod-validated)
//   2. boot the corpus reader — schema-validate in-process; per the rule
//      cli-read-ops-work-offline, this must work without the MCP server
//      running, so we do an explicit dry read at startup that just
//      surfaces issues to the log.
//   3. build the DI ctx: { auditLog, repoRootDetector, corpusReader,
//      cache, limiter }
//   4. import + register the 7 MCP tools from src/mcp-tools/ (Team C)
//   5. start hono on BETTERAI_MCP_PORT (default 7777)
//
// Per the four .betterai/STANDARDS/* rules:
//   - HTTP/SSE is the ONLY transport — no stdio path here.
//   - Bearer middleware is registered globally; only /health bypasses.
//   - Cache keys include scope + repo_root — handled in retrieve/.
//   - Audit emits use validateAuditEvent — handled in audit/jsonl.ts.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

import { bearerMiddleware } from "./auth/bearer.js";
import { ConnectionLimiter } from "./cache/connection-limiter.js";
import { ContextCache } from "./cache/context-hash.js";
import {
  JsonlAuditWriter,
  type AuditEvent,
  type AuditLogFn,
} from "./audit/jsonl.js";
import { MissedRetrievalDetector } from "./audit/missed-retrieval.js";
import { CorpusReader } from "./corpus/reader.js";
import { RepoDetector } from "./scope/repo-detector.js";
import { DomainRouter } from "./retrieve/router.js";
import { RetrievalOrchestrator } from "./retrieve/index.js";
import { registerHttpSseTransport } from "./transport/http-sse.js";

// ---- Public types re-exported for Team C ------------------------------

export type { Rule, Skill, Memory, Scope } from "./corpus/reader.js";
export type { AuditEvent, AuditLogFn, SubagentClass } from "./audit/jsonl.js";
export type {
  RetrieveInput,
  RetrieveOutput,
  ScopeFilter,
  OrchestratorMeta,
} from "./retrieve/index.js";

/**
 * The dependency-injection context that Team C's tool handlers receive
 * as their second argument.  Every tool gets the same shape; tools
 * never reach into globals.
 */
export interface ToolContext {
  auditLog: AuditLogFn;
  repoRootDetector: RepoDetector;
  corpusReader: CorpusReader;
  cache: ContextCache;
  orchestrator: RetrievalOrchestrator;
  limiter: ConnectionLimiter;
  missedRetrieval: MissedRetrievalDetector;
  /** Read-only config snapshot the tools may inspect. */
  config: Readonly<ResolvedEnv>;
}

// ---- The MCP tool contract Team C exports -----------------------------

export interface McpTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: I, ctx: ToolContext, meta: ToolCallMeta) => Promise<O>;
}

export interface ToolCallMeta {
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  subagent_class: import("./audit/jsonl.js").SubagentClass | null;
  tool_call_id: string;
}

// ---- Env --------------------------------------------------------------

const EnvSchema = z.object({
  BETTERAI_CORPUS_ROOT: z.string().default("/data"),
  BETTERAI_AUDIT_PATH: z.string().default("/data/audit/audit.jsonl"),
  BETTERAI_PROJECTS_ROOT: z.string().default("/projects"),
  BETTERAI_MCP_PORT: z.coerce.number().int().positive().default(7777),
  BETTERAI_TOKEN_PATH: z.string().default("/data/token"),
  BETTERAI_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  /** When set, bind to this host instead of 127.0.0.1 (tests only). */
  BETTERAI_BIND_HOST: z.string().default("127.0.0.1"),
});

export type ResolvedEnv = z.infer<typeof EnvSchema>;

function readEnv(): ResolvedEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `BETTERAI env config invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

// ---- Startup ----------------------------------------------------------

export interface StartedServer {
  app: Hono;
  mcpServer: McpServer;
  shutdown: () => Promise<void>;
  port: number;
}

export interface StartOptions {
  /**
   * Inject tools at start time (Team C does this in src/index.ts so the
   * server module never imports the tool implementations directly — the
   * DI direction is server → tools, never tools → server).
   */
  tools: McpTool[];
  /** Optional env override for tests. */
  env?: Partial<ResolvedEnv>;
}

/**
 * Boot the BetterAI MCP server.  Returns once the listener is bound.
 * The caller is responsible for awaiting `shutdown()` to close cleanly.
 */
export async function startServer(opts: StartOptions): Promise<StartedServer> {
  const env: ResolvedEnv = { ...readEnv(), ...(opts.env ?? {}) };

  // ---- 1. Boot the corpus reader (offline-capable schema validation) -
  const reader = new CorpusReader({ globalRoot: env.BETTERAI_CORPUS_ROOT });
  const snapshot = reader.read();
  if (snapshot.issues.length) {
    // Surface but do not crash — per cli-read-ops-work-offline we want
    // partial-corpus retrieval to keep working.
    console.warn(
      `[betterai] corpus loaded with ${snapshot.issues.length} validation issue(s)`,
    );
    for (const issue of snapshot.issues.slice(0, 20)) {
      console.warn(`  ${issue.path}: ${issue.message}`);
    }
  }

  // ---- 2. Build infrastructure ------------------------------------------
  const auditWriter = new JsonlAuditWriter({ path: env.BETTERAI_AUDIT_PATH });
  const auditLog: AuditLogFn = (event: AuditEvent) => auditWriter.append(event);
  const repoDetector = new RepoDetector();
  const cache = new ContextCache({ max: 256, ttlMs: 60_000 });
  const limiter = new ConnectionLimiter({ maxInFlight: 16, queueMax: 64 });
  const missedRetrieval = new MissedRetrievalDetector(auditLog);

  const router = DomainRouter.fromFile(
    `${env.BETTERAI_CORPUS_ROOT}/rules/_meta/domain-router.yaml`,
  );
  const orchestrator = new RetrievalOrchestrator({
    globalCorpusRoot: env.BETTERAI_CORPUS_ROOT,
    router,
    cache,
    repoDetector,
    auditLog,
  });

  // ---- 3. Assemble the DI context ---------------------------------------
  const ctx: ToolContext = {
    auditLog,
    repoRootDetector: repoDetector,
    corpusReader: reader,
    cache,
    orchestrator,
    limiter,
    missedRetrieval,
    config: env,
  };

  // ---- 4. Build the MCP server + register tools -------------------------
  const mcpServer = new McpServer(
    { name: "betterai", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  for (const tool of opts.tools) {
    registerMcpTool(mcpServer, tool, ctx);
  }

  // ---- 5. Build the Hono app --------------------------------------------
  const app = new Hono();

  // Bearer middleware before any tool dispatch — single chokepoint per
  // .betterai/rules/STANDARDS/security/mcp-tools-require-bearer.
  app.use(
    "*",
    bearerMiddleware({
      tokenPath: env.BETTERAI_TOKEN_PATH,
      onBypass: (info) =>
        auditLog({
          event_type: "explain",
          ts: new Date().toISOString(),
          agent_session_id: null,
          parent_agent_session_id: null,
          subagent_class: "main",
          tool_call_id: "auth.bypass",
          context_hash: "",
          repo_root_detected: null,
          scopes_queried: [],
          rules_returned: [
            {
              id: "auth.bypass",
              kind: "rule",
              scope: "global",
              domain: "security",
              score: 0,
              reason: `path=${info.path} ip=${info.ip} ua=${info.ua}`,
            },
          ],
          overridden_global_ids: [],
          latency_ms: 0,
          downstream_apply_event_id: null,
          downstream_commit_sha: null,
          downstream_violations: null,
        }),
    }),
  );

  registerHttpSseTransport(app, { mcpServer, limiter });

  // ---- 6. Bind the listener ---------------------------------------------
  const server = serve({
    fetch: app.fetch,
    port: env.BETTERAI_MCP_PORT,
    hostname: env.BETTERAI_BIND_HOST,
  });

  const shutdown = async () => {
    await new Promise<void>((resolve) => {
      (server as unknown as { close: (cb: () => void) => void }).close(() =>
        resolve(),
      );
    });
  };

  return {
    app,
    mcpServer,
    shutdown,
    port: env.BETTERAI_MCP_PORT,
  };
}

/**
 * Bridge between the framework-agnostic McpTool contract and the SDK's
 * registry.  Threads the DI ctx + per-call meta into every handler.
 */
function registerMcpTool(
  mcpServer: McpServer,
  tool: McpTool,
  ctx: ToolContext,
): void {
  const anyServer = mcpServer as unknown as {
    tool?: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (input: unknown, extra?: unknown) => Promise<unknown>,
    ) => void;
  };
  if (typeof anyServer.tool !== "function") {
    // TODO(phase-1.1): when the SDK exposes a different registration
    //                  shape, adapt here.  We deliberately don't depend
    //                  on the SDK's internal types beyond this point so
    //                  upgrades are local to this file.
    return;
  }
  anyServer.tool(
    tool.name,
    tool.description,
    tool.inputSchema,
    async (input, extra) => {
      const meta = extractMeta(extra);
      return tool.handler(input, ctx, meta);
    },
  );
}

function extractMeta(extra: unknown): ToolCallMeta {
  const e = (extra ?? {}) as Partial<ToolCallMeta> & {
    _meta?: Partial<ToolCallMeta>;
  };
  const src = e._meta ?? e;
  return {
    agent_session_id: src.agent_session_id ?? null,
    parent_agent_session_id: src.parent_agent_session_id ?? null,
    subagent_class: src.subagent_class ?? "main",
    tool_call_id:
      (src as { tool_call_id?: string }).tool_call_id ??
      `tc_${Math.random().toString(36).slice(2)}`,
  };
}
