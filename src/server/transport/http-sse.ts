// src/server/transport/http-sse.ts
//
// Hono routes that bridge MCP HTTP/SSE traffic into the
// @modelcontextprotocol/sdk Server.
//
// Per .betterai/rules/STANDARDS/maintainability/no-stdio-mcp-transport:
//   HTTP/SSE is the only transport.  Do not add a stdio path.  Even
//   behind an env var.  Even for "the local CLI".  The CLI uses HTTP.
//
// The transport surface:
//   GET  /health        — liveness (bearer bypass allowed; logged)
//   POST /mcp           — non-streaming MCP request/response envelope
//   GET  /mcp/sse       — Server-Sent Events stream for streaming tools
//
// The bearer middleware MUST be registered BEFORE this function on the
// `/mcp/*` path.  We register it once globally in main.ts so forgetting
// is impossible (see the rule's "Anti-patterns" section).

import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { TooManyInFlightError } from "../cache/connection-limiter.js";
import type { ConnectionLimiter } from "../cache/connection-limiter.js";

export interface HttpSseRegistrationOpts {
  mcpServer: McpServer;
  limiter: ConnectionLimiter;
}

/**
 * Register MCP HTTP + SSE routes on the given hono app.
 *
 * The actual MCP wire-protocol marshalling is delegated to the SDK's
 * Server instance; this file is the thin HTTP adapter that:
 *   - reads the JSON body
 *   - hands it to the SDK
 *   - returns the SDK's response as JSON
 * For streaming tool responses, /mcp/sse opens an SSE channel and the
 * SDK pushes events into it.
 *
 * NOTE: at the time of writing, the MCP SDK's HTTP/SSE transport API is
 * stabilizing.  We pin the integration to the "request → response"
 * shape and leave a TODO to track the SDK's official streamable-http
 * transport when it lands.
 */
export function registerHttpSseTransport(
  app: Hono,
  opts: HttpSseRegistrationOpts,
): void {
  // Health is intentionally a separate route so the bearer middleware
  // can allow-list its path explicitly.  No DB, no MCP, no auth — just
  // "the process is alive."
  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  // Non-streaming MCP envelope.  Most calls come through here; SSE is
  // only used when a tool genuinely streams.
  app.post("/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    try {
      const result = await opts.limiter.run(() =>
        dispatchMcpRequest(opts.mcpServer, body),
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof TooManyInFlightError) {
        return c.json(
          { error: "too_many_in_flight", retry_after_ms: 250 },
          429,
        );
      }
      return c.json(
        { error: "internal_error", detail: (err as Error).message },
        500,
      );
    }
  });

  // Streaming MCP envelope (SSE).  Long-lived; one open connection per
  // tool call that opts into streaming.  We keep the implementation
  // skeletal — Phase 1.0 tools are all synchronous.
  app.get("/mcp/sse", (c) =>
    streamSSE(c, async (stream) => {
      stream.writeSSE({ event: "ready", data: JSON.stringify({ ok: true }) });
      // TODO(phase-1.1): wire the MCP SDK's streamable transport here
      //                  once the SDK API lands.  Until then, this is a
      //                  no-op keep-alive channel so client SSE
      //                  detection works.
      const interval = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, 15_000);
      stream.onAbort(() => clearInterval(interval));
    }),
  );
}

/**
 * Bridge into the MCP SDK.  The SDK's server exposes a
 * `handleRequest`-style method via the transport abstraction; for the
 * HTTP path we synthesize a minimal transport surface here.
 *
 * TODO(phase-1.1): replace this with the SDK's official
 *                  StreamableHttpServerTransport once stable; we
 *                  intentionally do NOT register a stdio transport.
 */
async function dispatchMcpRequest(
  server: McpServer,
  body: unknown,
): Promise<unknown> {
  // The MCP SDK accepts JSON-RPC envelopes via its transports; here we
  // delegate by reaching into the public request handler.  This shim
  // exists because the SDK's official HTTP transport is still landing;
  // see the TODO above.
  const anyServer = server as unknown as {
    _onRequest?: (req: unknown) => Promise<unknown>;
  };
  if (typeof anyServer._onRequest !== "function") {
    return {
      error: "mcp_dispatch_unimplemented",
      detail:
        "Phase 1.0 placeholder — wire SDK's StreamableHttpServerTransport when it lands",
      echo: body,
    };
  }
  return anyServer._onRequest(body);
}
