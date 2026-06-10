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
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wave 5 reconciled API: startServer({ tools: McpTool[]; env?: Partial<ResolvedEnv> })
// returns StartedServer { app, mcpServer, shutdown, port }. Env knobs:
// BETTERAI_CORPUS_ROOT, BETTERAI_MCP_PORT, BETTERAI_TOKEN_PATH, BETTERAI_BIND_HOST.
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
});
