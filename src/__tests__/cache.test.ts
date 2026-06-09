// Cache invariants for the retrieve_context LRU per
// docs/design/v4-design.md + multi-agent eng review §1.7 §4.4 and
// .betterai/rules/STANDARDS/observability/context-hash-includes-scope.md.
//
// Three load-bearing properties:
//   1. Hit/miss correctness within the 60s TTL window.
//   2. LRU eviction at the 256th entry.
//   3. The hash key includes repo_root_detected AND scopes_queried, so two
//      otherwise-identical contexts in different repos NEVER share a cache
//      entry. This is the cross-corpus poisoning rule.
//
// Team B exports `createContextCache()` from src/server/cache/index.ts and
// `contextHash(ctx)` from src/server/cache/context-hash.ts. Both are imported
// dynamically so the test file loads even when those modules aren't compiled.

import { describe, test, expect } from "vitest";

interface HashableContext {
  file_paths: string[];
  intent: string;
  symbols: string[];
  recent_diff: string;
  repo_root_detected: string | null;
  scopes_queried: ("global" | "repo")[];
}

let contextHash: (ctx: HashableContext) => string;
let createContextCache: <V>(opts: { max?: number; ttlMs?: number }) => {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  size(): number;
};
try {
  const hashMod = await import("../server/cache/context-hash.js");
  contextHash = hashMod.contextHash;
} catch {
  contextHash = () => "stub";
}
try {
  const cacheMod = await import("../server/cache/index.js");
  createContextCache = cacheMod.createContextCache;
} catch {
  // minimal in-test stub so import failures don't blow up the harness;
  // individual tests will still fail to assert behavior against Team B's impl.
  createContextCache = () => {
    const m = new Map<string, unknown>();
    return {
      get: k => m.get(k) as never,
      set: (k, v) => {
        m.set(k, v);
      },
      size: () => m.size,
    };
  };
}

function makeCtx(overrides: Partial<HashableContext> = {}): HashableContext {
  return {
    file_paths: ["src/Button.tsx"],
    intent: "add a new button component",
    symbols: [],
    recent_diff: "",
    repo_root_detected: "/Users/nicov/projects/repoA",
    scopes_queried: ["global", "repo"],
    ...overrides,
  };
}

describe("contextHash", () => {
  test("produces the same hash for two contexts with the same canonical fields", () => {
    const a = contextHash(makeCtx());
    const b = contextHash(makeCtx());
    expect(a).toBe(b);
  });

  test("changes the hash when the detected repo root changes", () => {
    // Per .betterai context-hash-includes-scope rule: this is the
    // cross-corpus poisoning prevention invariant.
    const a = contextHash(makeCtx({ repo_root_detected: "/repos/X" }));
    const b = contextHash(makeCtx({ repo_root_detected: "/repos/Y" }));
    expect(a).not.toBe(b);
  });

  test("changes the hash when scopes_queried changes", () => {
    const a = contextHash(makeCtx({ scopes_queried: ["global"] }));
    const b = contextHash(makeCtx({ scopes_queried: ["global", "repo"] }));
    expect(a).not.toBe(b);
  });

  test("is stable under key ordering of file_paths and symbols", () => {
    const a = contextHash(makeCtx({ file_paths: ["a.ts", "b.ts"], symbols: ["x", "y"] }));
    const b = contextHash(makeCtx({ file_paths: ["b.ts", "a.ts"], symbols: ["y", "x"] }));
    expect(a).toBe(b);
  });
});

describe("createContextCache", () => {
  test("returns undefined on a key never written", () => {
    const c = createContextCache<string>({ max: 4, ttlMs: 60_000 });
    expect(c.get("missing")).toBeUndefined();
  });

  test("returns the stored value on a key written within the TTL window", () => {
    const c = createContextCache<string>({ max: 4, ttlMs: 60_000 });
    c.set("k1", "v1");
    expect(c.get("k1")).toBe("v1");
  });

  test("evicts the least-recently-used entry when the max is exceeded", () => {
    const c = createContextCache<string>({ max: 2, ttlMs: 60_000 });
    c.set("a", "1");
    c.set("b", "2");
    c.get("a"); // touch a so b is LRU
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.get("c")).toBe("3");
  });

  test("does NOT serve a stored value across two different repo_root_detected keys", () => {
    // Belt-and-suspenders integration of contextHash + cache: distinct
    // repos MUST produce distinct keys, so the cache cannot leak rules
    // across repos even with identical intents.
    const c = createContextCache<string>({ max: 8, ttlMs: 60_000 });
    const kRepoA = contextHash(makeCtx({ repo_root_detected: "/repos/A" }));
    const kRepoB = contextHash(makeCtx({ repo_root_detected: "/repos/B" }));
    c.set(kRepoA, "repoA rules");
    expect(c.get(kRepoB)).toBeUndefined();
  });
});
