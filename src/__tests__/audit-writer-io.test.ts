// G3 — JsonlAuditWriter filesystem partial-failure behavior.
// docs/RELIABILITY-TEST-GAPS.md, Tier 1, rank 4.
//
// The audit writer is BetterAI's ONLY observability surface; a silent
// IO failure here blackholes the entire compliance story. These tests
// pin the failure contract implemented in src/audit/jsonl.ts:
//
//   - append() THROWS a typed AuditIoError on filesystem failure
//     (never a raw errno crash, never a silent drop),
//   - construction stays filesystem-free (lazy dir init),
//   - parent-dir removal mid-run is recovered via lazy re-mkdir,
//   - external rotation/rename of the active file is survived by
//     recreating a fresh file at the configured path,
//   - created files carry mode 0o640 regardless of umask,
//   - concurrent >4KB appends land as intact, parseable JSONL lines.
//
// Per the gap doc's anti-recommendations: REAL tmpdirs, no fs mocks.

import { describe, test, expect, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditIoError,
  JsonlAuditWriter,
  type AuditEvent,
} from "../audit/jsonl.js";

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_type: "retrieve",
    ts: new Date().toISOString(),
    agent_session_id: "sess-io-test",
    parent_agent_session_id: null,
    subagent_class: "main",
    tool_call_id: `call-${Math.random().toString(36).slice(2)}`,
    context_hash: "hash-io-test",
    repo_root_detected: null,
    scopes_queried: ["global"],
    rules_returned: [],
    overridden_global_ids: [],
    latency_ms: 1,
    downstream_apply_event_id: null,
    downstream_commit_sha: null,
    downstream_violations: null,
    ...overrides,
  };
}

describe("JsonlAuditWriter IO failure behavior (real tmpdirs)", () => {
  const tmpRoots: string[] = [];

  function freshTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "betterai-audit-io-"));
    tmpRoots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      // Re-open any chmod-0o000 dirs so rmSync can clean them.
      try {
        chmodSync(root, 0o700);
        for (const sub of ["locked"]) {
          const p = join(root, sub);
          if (existsSync(p)) chmodSync(p, 0o700);
        }
      } catch {
        // best-effort cleanup
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(runningAsRoot)(
    "unwritable parent dir surfaces a typed AuditIoError, not a raw EACCES crash",
    () => {
      // Arrange: the dir the writer must mkdir into is mode 0o000.
      const root = freshTmp();
      const locked = join(root, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      const writer = new JsonlAuditWriter({
        path: join(locked, "audit", "audit.jsonl"),
      });

      // Act + Assert: typed error with the errno code preserved.
      let caught: unknown;
      try {
        writer.append(makeEvent());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AuditIoError);
      expect((caught as AuditIoError).code).toBe("EACCES");
      expect((caught as AuditIoError).path).toContain("audit.jsonl");
    },
  );

  test("audit path pointing at an EXISTING DIRECTORY surfaces a typed error, not EISDIR", () => {
    // Arrange: the exact live-smoke-test failure from 2026-06-10 —
    // BETTERAI_AUDIT_PATH set to a directory.
    const root = freshTmp();
    const dirAsPath = join(root, "audit.jsonl");
    mkdirSync(dirAsPath); // a directory wearing a file's name
    const writer = new JsonlAuditWriter({ path: dirAsPath });

    // Act + Assert
    let caught: unknown;
    try {
      writer.append(makeEvent());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuditIoError);
    expect((caught as AuditIoError).message).toContain("is a directory");
    expect((caught as AuditIoError).message).toContain("BETTERAI_AUDIT_PATH");
  });

  test("construction never touches the filesystem (failure is deferred to append)", () => {
    // Arrange: a path that cannot possibly be created.
    const writer = new JsonlAuditWriter({
      path: "/nonexistent-betterai-root/audit/audit.jsonl",
    });

    // Act + Assert: constructing is fine; append throws typed.
    expect(writer).toBeInstanceOf(JsonlAuditWriter);
    expect(() => writer.append(makeEvent())).toThrowError(AuditIoError);
  });

  test("created audit files carry mode 0o640 regardless of process umask", () => {
    // Arrange
    const root = freshTmp();
    const path = join(root, "audit", "audit.jsonl");
    const writer = new JsonlAuditWriter({ path });
    const previousUmask = process.umask(0o077); // stricter than 0o640

    // Act
    try {
      writer.append(makeEvent());
    } finally {
      process.umask(previousUmask);
    }

    // Assert: owner rw, group r, world nothing.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  test("50 concurrent >4KB appends each land as a single intact JSONL line", async () => {
    // Arrange: events whose serialized size exceeds PIPE_BUF (4096 bytes).
    const root = freshTmp();
    const path = join(root, "audit.jsonl");
    const writer = new JsonlAuditWriter({ path });
    const bigDiffNote = "x".repeat(5000);
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        tool_call_id: `call-${i}`,
        context_hash: bigDiffNote, // pushes each line past 4KB
      }),
    );

    // Act: fire all appends through the microtask queue concurrently.
    await Promise.all(
      events.map((e) => Promise.resolve().then(() => writer.append(e))),
    );

    // Assert: every line parses as JSON, none interleaved, none lost.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(50);
    const seen = new Set<string>();
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(4096);
      const parsed = JSON.parse(line) as AuditEvent;
      expect(parsed.context_hash).toBe(bigDiffNote);
      seen.add(parsed.tool_call_id);
    }
    expect(seen.size).toBe(50);
  });

  test("audit file renamed mid-run: writer recreates the file; subsequent events are not lost", () => {
    // Arrange: one event lands, then someone rotates the file externally.
    const root = freshTmp();
    const path = join(root, "audit.jsonl");
    const writer = new JsonlAuditWriter({ path });
    writer.append(makeEvent({ tool_call_id: "before-rotation" }));
    renameSync(path, join(root, "audit-rotated-away.jsonl"));

    // Act
    writer.append(makeEvent({ tool_call_id: "after-rotation" }));

    // Assert: a fresh file exists at the configured path with the new
    // event; the rotated-away file still holds the old one.
    const fresh = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(fresh.length).toBe(1);
    expect((JSON.parse(fresh[0]) as AuditEvent).tool_call_id).toBe(
      "after-rotation",
    );
    const rotated = readFileSync(join(root, "audit-rotated-away.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect((JSON.parse(rotated[0]) as AuditEvent).tool_call_id).toBe(
      "before-rotation",
    );
  });

  test("parent dir removed after a successful append: next append recovers via lazy re-mkdir", () => {
    // Arrange: first append initializes the dir, then the dir is rm -rf'd.
    const root = freshTmp();
    const dir = join(root, "audit");
    const path = join(dir, "audit.jsonl");
    const writer = new JsonlAuditWriter({ path });
    writer.append(makeEvent({ tool_call_id: "before-rm" }));
    rmSync(dir, { recursive: true, force: true });

    // Act: contract is lazy-mkdir RECOVERY — the event must not be lost.
    writer.append(makeEvent({ tool_call_id: "after-rm" }));

    // Assert
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]) as AuditEvent).tool_call_id).toBe("after-rm");
  });

  test.skipIf(runningAsRoot)(
    "parent dir removed AND unrecoverable: typed AuditIoError surfaces (no silent drop)",
    () => {
      // Arrange: dir is removed and its parent made unwritable, so the
      // lazy re-mkdir recovery itself must fail.
      const root = freshTmp();
      const locked = join(root, "locked");
      const dir = join(locked, "audit");
      const path = join(dir, "audit.jsonl");
      mkdirSync(dir, { recursive: true });
      const writer = new JsonlAuditWriter({ path });
      writer.append(makeEvent({ tool_call_id: "before" }));
      rmSync(dir, { recursive: true, force: true });
      chmodSync(locked, 0o000);

      // Act + Assert
      let caught: unknown;
      try {
        writer.append(makeEvent({ tool_call_id: "after" }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AuditIoError);
      expect((caught as AuditIoError).code).toBe("EACCES");
    },
  );
});
