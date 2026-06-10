// End-to-end MCP test: boot the real server (real tools, tmpdir corpus
// fixture, ephemeral port) and drive it with the SDK's own Client +
// StreamableHTTPClientTransport — NOT hand-rolled JSON-RPC — so the test
// exercises the exact wire protocol a real MCP client (Claude Code) uses.
//
// Covered surface:
//   (a) initialize handshake succeeds; serverInfo present
//   (b) tools/list returns the 7 registered tools
//   (c) tools/call retrieve_context returns rules; the audit event lands
//       and carries the transport session id (extra.sessionId fallback)
//   (d) malformed JSON-RPC body → JSON-RPC error envelope, not a crash
//   (e) unknown tool → JSON-RPC error
//   (f) tool handler throws → isError tool result, not HTTP 500
//   plus: DELETE /mcp terminates the session (subsequent use → 404)
//
// Auth: bearer middleware wraps /mcp (only /health bypasses), so the client
// transport sets the Authorization header via requestInit.  The server's
// Host allowlist is derived from BETTERAI_BIND_HOST + BETTERAI_MCP_PORT in
// the env layer, so the ephemeral test port is accepted without touching
// bearer.ts.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startServer, type StartedServer } from "../server/main.js";
import retrieveContext from "../mcp-tools/retrieve-context.js";
import retrieveRules from "../mcp-tools/retrieve-rules.js";
import retrieveSkills from "../mcp-tools/retrieve-skills.js";
import retrieveMemories from "../mcp-tools/retrieve-memories.js";
import checkFile from "../mcp-tools/check-file.js";
import explainRule from "../mcp-tools/explain-rule.js";
import recordMemory from "../mcp-tools/record-memory.js";

const ALL_TOOLS = [
  retrieveContext,
  retrieveRules,
  retrieveSkills,
  retrieveMemories,
  checkFile,
  explainRule,
  recordMemory,
];

const TOKEN = "e2e-test-token-1234567890";

const RULE_FIXTURE = `---
id: use-snake-case
title: Use snake_case for identifiers
category: STANDARDS
domain: naming
severity: medium
created: 2026-06-09
---

## What this rule says
Use snake_case.

## Why it matters
Consistency.

## When this applies
TypeScript files.

## What good looks like
\`\`\`ts
const some_value = 1;
\`\`\`

## Anti-patterns
camelCase everywhere.
`;

/** Ask the OS for a free ephemeral port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("MCP streamable HTTP transport end-to-end", () => {
  let corpusRoot: string;
  let tokenDir: string;
  let auditPath: string;
  let server: StartedServer | null = null;
  let port: number;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  function makeTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
    );
  }

  beforeAll(async () => {
    corpusRoot = mkdtempSync(join(tmpdir(), "betterai-e2e-corpus-"));
    mkdirSync(join(corpusRoot, "rules", "STANDARDS", "naming"), {
      recursive: true,
    });
    mkdirSync(join(corpusRoot, "skills"), { recursive: true });
    mkdirSync(join(corpusRoot, "memories"), { recursive: true });
    writeFileSync(
      join(corpusRoot, "rules", "STANDARDS", "naming", "use-snake-case.md"),
      RULE_FIXTURE,
    );

    tokenDir = mkdtempSync(join(tmpdir(), "betterai-e2e-token-"));
    const tokenPath = join(tokenDir, "token");
    writeFileSync(tokenPath, `${TOKEN}\n`);

    auditPath = join(corpusRoot, "audit", "audit.jsonl");

    port = await getFreePort();
    server = await startServer({
      tools: ALL_TOOLS,
      env: {
        BETTERAI_CORPUS_ROOT: corpusRoot,
        BETTERAI_MCP_PORT: port,
        BETTERAI_TOKEN_PATH: tokenPath,
        BETTERAI_BIND_HOST: "127.0.0.1",
        BETTERAI_AUDIT_PATH: auditPath,
        BETTERAI_PROJECTS_ROOT: join(corpusRoot, "projects"),
      },
    });

    transport = makeTransport();
    client = new Client({ name: "betterai-e2e", version: "0.0.1" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // session may already be gone
    }
    if (server) await server.shutdown();
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(tokenDir, { recursive: true, force: true });
  });

  test("(a) initialize handshake succeeds and serverInfo is present", () => {
    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo?.name).toBe("betterai");
    expect(serverInfo?.version).toBe("0.1.0");
    expect(transport.sessionId).toBeTruthy();
  });

  test("(b) tools/list returns the 7 registered tools", async () => {
    const res = await client.listTools();
    expect(res.tools).toHaveLength(7);
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "check_file",
        "explain_rule",
        "record_memory",
        "retrieve_context",
        "retrieve_memories",
        "retrieve_rules",
        "retrieve_skills",
      ].sort(),
    );
  });

  test("(c) tools/call retrieve_context returns rules and the audit event carries the session id", async () => {
    const result = await client.callTool({
      name: "retrieve_context",
      arguments: { context: {} },
    });
    expect(result.isError).toBeFalsy();

    const out = result.structuredContent as {
      rules: Array<{ id: string; scope: string }>;
      scopes_queried: string[];
    };
    expect(out).toBeDefined();
    expect(out.rules.length).toBeGreaterThanOrEqual(1);
    expect(out.rules.map((r) => r.id)).toContain("use-snake-case");
    expect(out.scopes_queried).toContain("global");

    // The audit event must land on disk and carry the MCP transport
    // session id as agent_session_id (the extra.sessionId fallback —
    // this client passes no _meta).
    expect(existsSync(auditPath)).toBe(true);
    const events = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const retrieveEvents = events.filter(
      (e) => e.event_type === "retrieve",
    );
    expect(retrieveEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      retrieveEvents.some(
        (e) => e.agent_session_id === transport.sessionId,
      ),
    ).toBe(true);
  });

  test("(d) malformed JSON-RPC body returns a JSON-RPC error envelope, not a crash", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32700);

    // The server must still be fully alive for the established session.
    const after = await client.listTools();
    expect(after.tools).toHaveLength(7);
  });

  test("(e) unknown tool returns a JSON-RPC method-not-found error", async () => {
    // SDK 1.29's McpServer surfaces the JSON-RPC InvalidParams (-32602)
    // "tool not found" error as an isError tool result rather than a
    // protocol-level rejection.
    const result = await client.callTool({
      name: "no_such_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toMatch(/-32602/);
    expect(text.text).toMatch(/no_such_tool not found/);
  });

  test("(f) a tool handler throw surfaces as an isError result, not HTTP 500", async () => {
    const result = await client.callTool({
      name: "explain_rule",
      arguments: { rule_id: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toMatch(/does-not-exist/);
  });

  test("DELETE /mcp terminates the session; reuse of the dead session id is rejected", async () => {
    // Use a dedicated client so the shared session keeps working for
    // other tests regardless of execution order.
    const t2 = makeTransport();
    const c2 = new Client({ name: "betterai-e2e-2", version: "0.0.1" });
    await c2.connect(t2);
    const deadSessionId = t2.sessionId;
    expect(deadSessionId).toBeTruthy();

    await t2.terminateSession(); // sends DELETE /mcp
    await c2.close();

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": deadSessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });
});
