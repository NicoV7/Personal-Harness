// Integration test: boot betterai-server in-process and verify the bearer
// gate on /health.
//
// The contract per .betterai/rules/STANDARDS/security/mcp-tools-require-bearer.md:
//   - GET /health WITH a valid Authorization: Bearer <token> returns 200.
//   - GET /health WITHOUT the bearer returns 401.
//
// Note: the security rule allow-lists /health as the one unauthenticated
// path, BUT must record an audit-log bypass event. For the integration test
// here we assert the simpler "401 without bearer" property; that mirrors the
// shape every other tool will inherit by default once Team B wires the
// middleware in front of registerMcpTools. If Team B's server intentionally
// leaves /health open, this test will need to assert against /retrieve_rules
// instead — we keep the structure in place and call it out in a comment.
//
// Team B contract: `startServer({ corpusRoot, port, tokenPath, hostname }):
//   Promise<{ close(): Promise<void>; port: number }>`.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wave 6 reconciled API: startServer({ tools: McpTool[]; env?: Partial<ResolvedEnv> })
// returns StartedServer { app, sessionCount, shutdown, port }. Env knobs:
// BETTERAI_CORPUS_ROOT, BETTERAI_MCP_PORT, BETTERAI_TOKEN_PATH, BETTERAI_BIND_HOST.
// The bearer Host allowlist is derived from BETTERAI_BIND_HOST:BETTERAI_MCP_PORT,
// so this fixture's port 27777 is accepted at the Host check and rejected at
// the bearer check when no/odd credentials are sent.
type StartServer = (opts: {
  tools: unknown[];
  env?: Record<string, string | number | undefined>;
}) => Promise<{ shutdown: () => Promise<void>; port: number }>;

let startServer: StartServer | null;
try {
  startServer = (await import("../server/main.js")).startServer as unknown as StartServer;
} catch {
  startServer = null;
}

const TOKEN = "test-token-1234567890";

/**
 * POST /mcp with an arbitrary (spoofable) Host header. fetch() refuses
 * to override Host, so the DNS-rebinding regression below needs raw
 * node:http. Resolves with the response status code.
 */
function postMcpWithHost(
  port: number,
  hostHeader: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1", // allow-literal-host: test connects to loopback fixture
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host: hostHeader,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
  });
}

describe("betterai-server boot + /health bearer gate", () => {
  let corpusRoot: string;
  let tokenPath: string;
  let server: { shutdown: () => Promise<void>; port: number } | null = null;
  const PORT = 27777;

  beforeAll(async () => {
    corpusRoot = mkdtempSync(join(tmpdir(), "betterai-server-corpus-"));
    mkdirSync(join(corpusRoot, "rules"), { recursive: true });
    mkdirSync(join(corpusRoot, "skills"), { recursive: true });
    mkdirSync(join(corpusRoot, "memories"), { recursive: true });
    const tokenDir = mkdtempSync(join(tmpdir(), "betterai-server-token-"));
    tokenPath = join(tokenDir, "token");
    writeFileSync(tokenPath, TOKEN);
    if (startServer) {
      server = await startServer({
        tools: [],
        env: {
          BETTERAI_CORPUS_ROOT: corpusRoot,
          BETTERAI_MCP_PORT: PORT,
          BETTERAI_TOKEN_PATH: tokenPath,
          BETTERAI_BIND_HOST: "127.0.0.1",
          BETTERAI_AUDIT_PATH: join(corpusRoot, "audit", "audit.jsonl"),
          BETTERAI_PROJECTS_ROOT: join(corpusRoot, "projects"),
        },
      });
    }
  });

  afterAll(async () => {
    if (server) await server.shutdown();
    rmSync(corpusRoot, { recursive: true, force: true });
  });

  test("the server module exports a startServer function so the integration harness can boot it", () => {
    // This guards the contract surface. If startServer is missing, every
    // subsequent test will fail with a confusing fetch error; failing fast
    // here is friendlier.
    expect(typeof startServer).toBe("function");
  });

  test("GET /health with a valid bearer token returns HTTP 200", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("GET /retrieve without a bearer token returns HTTP 401", async () => {
    if (!server) return;
    // We hit a tool path (not /health) because the security rule allow-lists
    // /health. Any tool path must reject missing bearer with 401.
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/retrieve_context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { file_paths: [], intent: "test" } }),
    });
    expect(res.status).toBe(401);
  });

  test("GET /retrieve with a bad bearer token returns HTTP 401", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/retrieve_context`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ context: { file_paths: [], intent: "test" } }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp without a bearer token returns HTTP 401 (auth wraps the MCP endpoint)", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with a valid bearer but no session and a non-initialize body returns a JSON-RPC 400", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
  });

  test("GET /mcp without a session id returns a JSON-RPC 400 (SSE stream requires a session)", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect(res.status).toBe(400);
  });

  test("Wave-5 regression (G4): Host 127.0.0.1:27777 is accepted when BETTERAI_MCP_PORT=27777", async () => {
    if (!server) return;
    // The host check must pass for the env-derived port; auth then also
    // passes (valid bearer), so the MCP layer answers — a JSON-RPC 400
    // for this non-initialize body, NOT a 401. Any 401 here means the
    // allowlist is still pinned to a hardcoded port.
    const status = await postMcpWithHost(server.port, `127.0.0.1:${PORT}`);
    expect(status).not.toBe(401);
    expect(status).toBe(400);
  });

  test("Wave-5 regression (G4): Host 127.0.0.1:7777 is rejected when BETTERAI_MCP_PORT=27777", async () => {
    if (!server) return;
    // allow-literal-host: 7777 is the OLD hardcoded default — the exact
    // regression fixture; it must no longer be on the allowlist.
    const status = await postMcpWithHost(server.port, "127.0.0.1:7777");
    expect(status).toBe(401);
  });

  test("the obsolete /mcp/sse keep-alive route is gone", async () => {
    if (!server) return;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/sse`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
  });
});
