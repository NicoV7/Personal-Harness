// src/server/transport/http-sse.ts
//
// Hono routes that bridge MCP Streamable HTTP traffic into the
// @modelcontextprotocol/sdk via WebStandardStreamableHTTPServerTransport
// (fetch-native: handleRequest(req: Request): Promise<Response> — no
// Node req/res bridging).
//
// Per .betterai/rules/STANDARDS/maintainability/no-stdio-mcp-transport:
//   HTTP/SSE is the only transport.  Do not add a stdio path.  Even
//   behind an env var.  Even for "the local CLI".  The CLI uses HTTP.
//
// The transport surface (MCP Streamable HTTP spec):
//   GET    /health — liveness (bearer bypass allowed; logged)
//   POST   /mcp    — JSON-RPC requests.  An `initialize` request without an
//                    mcp-session-id header creates a new session (the SDK
//                    transport generates the id and returns it in the
//                    response headers).  Subsequent requests carry the
//                    mcp-session-id header.
//   GET    /mcp    — the session's SSE notification stream (long-lived).
//   DELETE /mcp    — terminates the session.
//
// Statefulness: one McpServer + transport pair per session, kept in an
// in-memory map keyed by the SDK-generated session id.  All sessions share
// the same ToolContext singletons (cache, limiter, audit writer, corpus
// reader) — only the protocol state machine is per-session.
//
// The bearer middleware MUST be registered BEFORE this function on the
// `/mcp` path.  We register it once globally in main.ts so forgetting
// is impossible (see the rule's "Anti-patterns" section).

import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TooManyInFlightError } from "../cache/connection-limiter.js";
import type { ConnectionLimiter } from "../cache/connection-limiter.js";

// Idle-session GC window.  Mirrors the sweep pattern in
// src/server/audit/missed-retrieval.ts: we sweep opportunistically on
// each request instead of holding a timer that would keep the process
// alive.  30 minutes — MCP clients (Claude Code et al.) keep sessions
// open across an editing session, so this only reaps abandoned ones.
const IDLE_SESSION_GC_MS = 30 * 60_000;

/** Suggested client backoff when the connection limiter overflows. */
const RETRY_AFTER_MS = 250;

// JSON-RPC error codes (mirroring the SDK transport's own choices).
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_BAD_REQUEST = -32000;
const JSONRPC_SESSION_NOT_FOUND = -32001;

interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeenMs: number;
}

export interface HttpSseRegistrationOpts {
  /**
   * Session factory: builds a fresh McpServer (with all tools registered
   * against the SHARED ToolContext) for each new MCP session.  Provided
   * by main.ts so this module never imports tool implementations.
   */
  createMcpServer: () => McpServer;
  limiter: ConnectionLimiter;
  /** Override the idle-session GC window (tests). */
  idleSessionGcMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface HttpSseTransportHandle {
  /** Number of live MCP sessions (diagnostics + tests). */
  sessionCount: () => number;
  /** Close every live session; called from startServer's shutdown. */
  closeAllSessions: () => Promise<void>;
}

/**
 * Register MCP Streamable-HTTP routes on the given hono app.
 *
 * Concurrency: the ConnectionLimiter wraps POST /mcp dispatch only.
 * GET /mcp opens a long-lived SSE notification stream — if those held
 * permits, 16 idle sessions would exhaust the limiter and deadlock the
 * server, so GET (and DELETE) deliberately bypass it.
 */
export function registerHttpSseTransport(
  app: Hono,
  opts: HttpSseRegistrationOpts,
): HttpSseTransportHandle {
  const sessions = new Map<string, McpSession>();
  const now = opts.now ?? (() => Date.now());
  const idleGcMs = opts.idleSessionGcMs ?? IDLE_SESSION_GC_MS;

  // Health is intentionally a separate route so the bearer middleware
  // can allow-list its path explicitly.  No DB, no MCP, no auth — just
  // "the process is alive."
  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  function destroySession(id: string, session: McpSession): void {
    sessions.delete(id);
    // server.close() also closes its transport; we close both
    // defensively because GC can race a DELETE.
    void session.transport.close().catch(() => {});
    void session.server.close().catch(() => {});
  }

  function gcIdleSessions(nowMs: number): void {
    for (const [id, session] of sessions) {
      if (nowMs - session.lastSeenMs > idleGcMs) destroySession(id, session);
    }
  }

  function jsonRpcError(
    c: Context,
    status: ContentfulStatusCode,
    code: number,
    message: string,
  ) {
    return c.json(
      { jsonrpc: "2.0", error: { code, message }, id: null },
      status,
    );
  }

  app.all("/mcp", async (c) => {
    const nowMs = now();
    gcIdleSessions(nowMs);

    const sessionId = c.req.header("mcp-session-id");
    const method = c.req.method;

    // ---- Existing session: route to its transport ---------------------
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonRpcError(
          c,
          404,
          JSONRPC_SESSION_NOT_FOUND,
          "Session not found",
        );
      }
      session.lastSeenMs = nowMs;

      if (method === "POST") {
        return dispatchWithLimiter(c, () =>
          session.transport.handleRequest(c.req.raw),
        );
      }
      // GET = long-lived SSE notification stream; DELETE = session
      // teardown.  Neither holds a limiter permit (see fn doc).  The
      // transport's onclose/onsessionclosed hooks remove the session
      // from the map on DELETE.
      return session.transport.handleRequest(c.req.raw);
    }

    // ---- No session header: only `initialize` over POST is legal ------
    if (method !== "POST") {
      return jsonRpcError(
        c,
        400,
        JSONRPC_BAD_REQUEST,
        "Bad Request: mcp-session-id header is required",
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonRpcError(c, 400, JSONRPC_PARSE_ERROR, "Parse error: invalid JSON");
    }
    if (!isInitializeRequest(body)) {
      return jsonRpcError(
        c,
        400,
        JSONRPC_BAD_REQUEST,
        "Bad Request: no valid session ID provided and request is not an initialize request",
      );
    }

    // ---- New session ---------------------------------------------------
    const server = opts.createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastSeenMs: now() });
      },
      onsessionclosed: (id) => {
        const session = sessions.get(id);
        if (session) destroySession(id, session);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.has(id)) sessions.delete(id);
    };
    await server.connect(transport);

    // The body was already consumed above for the initialize sniff, so we
    // hand the parsed copy to the transport.
    return dispatchWithLimiter(c, () =>
      transport.handleRequest(c.req.raw, { parsedBody: body }),
    );
  });

  async function dispatchWithLimiter(
    c: Context,
    dispatch: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await opts.limiter.run(dispatch);
    } catch (err) {
      if (err instanceof TooManyInFlightError) {
        return c.json(
          { error: "too_many_in_flight", retry_after_ms: RETRY_AFTER_MS },
          429,
        );
      }
      return c.json(
        { error: "internal_error", detail: (err as Error).message },
        500,
      );
    }
  }

  return {
    sessionCount: () => sessions.size,
    closeAllSessions: async () => {
      for (const [id, session] of sessions) destroySession(id, session);
    },
  };
}
