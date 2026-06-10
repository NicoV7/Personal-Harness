// G4 (docs/RELIABILITY-TEST-GAPS.md): adversarial-input coverage for the
// bearer middleware — the security boundary. The middleware is exercised
// in-process via a hono app (no listener, no ports), so this file is
// parallel-safe and depends on no external state. Token files live in
// real tmpdirs per the testing rules (no fs mocks).
//
// All host/port literals in this file are test fixtures, not config:
// // allow-literal-host: adversarial fixtures pinned by the test contract

import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import {
  bearerMiddleware,
  constantTimeEqual,
  BearerTokenEmptyError,
  BearerTokenMissingError,
} from "../auth/bearer.js";
import {
  allowedHostsFromEnv,
  allowedHostsFromProcessEnv,
  EnvSchema,
} from "../contracts/env.js";

const TOKEN = "adversarial-test-token-0123456789";
// allow-literal-host: fixture allowlist the app under test accepts
const GOOD_HOST = "127.0.0.1:7777";

/** Write a fresh token file in a real tmpdir; returns its path. */
function writeTokenFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "betterai-bearer-adv-"));
  const tokenPath = join(dir, "token");
  writeFileSync(tokenPath, contents, { mode: 0o600 });
  return tokenPath;
}

interface BypassEvent {
  path: string;
  ip: string;
  ua: string;
}

/**
 * Build an in-process hono app guarded by the bearer middleware. Routes
 * mirror the real server's surface: /health (allowlisted) plus catch-all
 * protected handlers so probes like /healthz and /mcp/anything resolve
 * to a 200 IF (and only if) auth lets them through.
 */
function makeApp(tokenFileContents: string = `${TOKEN}\n`): {
  app: Hono;
  bypasses: BypassEvent[];
} {
  const bypasses: BypassEvent[] = [];
  const app = new Hono();
  app.use(
    "*",
    bearerMiddleware({
      tokenPath: writeTokenFile(tokenFileContents),
      allowedHosts: new Set([GOOD_HOST]),
      onBypass: (info) => bypasses.push(info),
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  app.all("*", (c) => c.json({ reached: "protected" }));
  return { app, bypasses };
}

/** Shorthand: fire a request at the in-process app, return the Response. */
function probe(
  app: Hono,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<Response> {
  return app.request(path, { method, headers });
}

// ---------------------------------------------------------------------------

describe("bearer middleware: malformed Authorization headers (valid Host)", () => {
  const cases: Array<[label: string, header: string]> = [
    ["no scheme, bare token", TOKEN],
    ["lowercase scheme `bearer`", `bearer ${TOKEN}`],
    ["double space after scheme", `Bearer  ${TOKEN}`],
    ["empty value after scheme", "Bearer "],
    ["scheme only, no space", "Bearer"],
    ["wrong scheme `Basic`", `Basic ${TOKEN}`],
    ["non-ASCII token value", "Bearer tök§n-ÿ"],
  ];

  for (const [label, header] of cases) {
    test(`${label} → 401`, async () => {
      const { app } = makeApp();
      const res = await probe(app, "/mcp", {
        host: GOOD_HOST,
        authorization: header,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  }

  test("correct header still passes (control case)", async () => {
    const { app } = makeApp();
    const res = await probe(app, "/mcp", {
      host: GOOD_HOST,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "protected" });
  });
});

describe("bearer middleware: Host header (DNS-rebinding defense)", () => {
  test("missing Host header entirely → 401 host_not_allowed", async () => {
    const { app } = makeApp();
    // app.request sets no Host header unless we do.
    const res = await probe(app, "/mcp", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "host_not_allowed" });
  });

  test("spoofed Host evil.example.com → 401 even with a valid token", async () => {
    const { app } = makeApp();
    const res = await probe(app, "/mcp", {
      host: "evil.example.com", // allow-literal-host: spoof fixture
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "host_not_allowed" });
  });

  test("port-mismatched Host (right ip, wrong port) → 401", async () => {
    const { app } = makeApp();
    const res = await probe(app, "/mcp", {
      host: "127.0.0.1:8888", // allow-literal-host: port-mismatch fixture
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "host_not_allowed" });
  });
});

describe("bearer middleware: /health bypass surface", () => {
  test("/health works WITHOUT a token and emits an auth-bypass audit event", async () => {
    const { app, bypasses } = makeApp();
    const res = await probe(app, "/health", {
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "adversarial-probe/1.0",
    });
    expect(res.status).toBe(200);
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]).toEqual({
      path: "/health",
      ip: "203.0.113.9",
      ua: "adversarial-probe/1.0",
    });
  });

  test("/health is the ONLY bypass: lookalike paths all require auth", async () => {
    const { app, bypasses } = makeApp();
    for (const path of ["/healthz", "/health/", "/mcp", "/mcp/anything"]) {
      const res = await probe(app, path, { host: GOOD_HOST }, "POST");
      expect(res.status, `expected 401 for unauthenticated ${path}`).toBe(401);
    }
    // None of the protected probes may have fired the bypass emitter.
    expect(bypasses).toHaveLength(0);
  });
});

describe("bearer middleware: token file semantics at construction", () => {
  test("empty token file → typed BearerTokenEmptyError (BAI-102)", () => {
    const tokenPath = writeTokenFile("");
    expect(() => bearerMiddleware({ tokenPath })).toThrow(
      BearerTokenEmptyError,
    );
    try {
      bearerMiddleware({ tokenPath });
      expect.unreachable("construction must throw on an empty token file");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerTokenEmptyError);
      expect((err as BearerTokenEmptyError).code).toBe("BAI-102");
    }
  });

  test("whitespace-only token file → typed BearerTokenEmptyError", () => {
    const tokenPath = writeTokenFile("  \n\n\t ");
    expect(() => bearerMiddleware({ tokenPath })).toThrow(
      BearerTokenEmptyError,
    );
  });

  test("missing token file → typed BearerTokenMissingError (BAI-101)", () => {
    const tokenPath = join(
      mkdtempSync(join(tmpdir(), "betterai-bearer-missing-")),
      "does-not-exist",
    );
    try {
      bearerMiddleware({ tokenPath });
      expect.unreachable("construction must throw on a missing token file");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerTokenMissingError);
      expect((err as BearerTokenMissingError).code).toBe("BAI-101");
    }
  });

  test("token file with trailing newline matches the bare header value (trim semantics)", async () => {
    const { app } = makeApp(`${TOKEN}\n`);
    const res = await probe(app, "/mcp", {
      host: GOOD_HOST,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  test("token rotation requires restart: rewriting the file does NOT change the accepted token", async () => {
    // Decision (b) in src/auth/bearer.ts: the token is cached at
    // construction; this test pins that contract so a future re-read
    // implementation changes it deliberately, not accidentally.
    const tokenPath = writeTokenFile(`${TOKEN}\n`);
    const app = new Hono();
    app.use(
      "*",
      bearerMiddleware({ tokenPath, allowedHosts: new Set([GOOD_HOST]) }),
    );
    app.all("*", (c) => c.json({ reached: "protected" }));

    writeFileSync(tokenPath, "rotated-token-after-boot\n");

    const oldToken = await probe(app, "/mcp", {
      host: GOOD_HOST,
      authorization: `Bearer ${TOKEN}`,
    });
    const newToken = await probe(app, "/mcp", {
      host: GOOD_HOST,
      authorization: "Bearer rotated-token-after-boot",
    });
    expect(oldToken.status).toBe(200);
    expect(newToken.status).toBe(401);
  });
});

describe("bearer middleware: constant-time comparison", () => {
  test("structural: the implementation calls node:crypto timingSafeEqual", () => {
    // Structural assertion, not a microbenchmark: the source of the auth
    // module must route token comparison through timingSafeEqual.
    const source = readFileSync(
      fileURLToPath(new URL("../auth/bearer.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*timingSafeEqual[^}]*\}\s*from\s*"node:crypto"/,
    );
    expect(source).toMatch(/return timingSafeEqual\(/);
  });

  test("behavioral: equal strings match; unequal and length-skewed strings do not", () => {
    expect(constantTimeEqual(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(constantTimeEqual(TOKEN, "short")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", TOKEN)).toBe(false);
  });
});

describe("allowed-hosts derivation (single source of truth in contracts/env)", () => {
  test("Wave-5 regression at the unit level: port 27777 derives :27777 hosts, never :7777", () => {
    const hosts = allowedHostsFromEnv(
      EnvSchema.parse({ BETTERAI_MCP_PORT: "27777" }),
    );
    expect(hosts).toEqual(new Set(["127.0.0.1:27777", "localhost:27777"]));
    expect(hosts.has("127.0.0.1:7777")).toBe(false);
  });

  test("non-loopback bind host drops the localhost alias", () => {
    const hosts = allowedHostsFromEnv(
      EnvSchema.parse({
        BETTERAI_BIND_HOST: "10.0.0.5", // allow-literal-host: fixture
        BETTERAI_MCP_PORT: "7777",
      }),
    );
    expect(hosts).toEqual(new Set(["10.0.0.5:7777"]));
  });

  test("BETTERAI_ALLOWED_HOSTS is an explicit override of the derived set", () => {
    const hosts = allowedHostsFromProcessEnv({
      BETTERAI_ALLOWED_HOSTS: "betterai.internal:9999, 10.0.0.5:443",
      BETTERAI_BIND_HOST: "127.0.0.1",
      BETTERAI_MCP_PORT: "27777",
    });
    expect(hosts).toEqual(new Set(["betterai.internal:9999", "10.0.0.5:443"]));
  });

  test("allowedHostsFromProcessEnv derives from raw string env vars with defaults applied", () => {
    const hosts = allowedHostsFromProcessEnv({ BETTERAI_MCP_PORT: "27777" });
    expect(hosts).toEqual(new Set(["127.0.0.1:27777", "localhost:27777"]));
  });
});
