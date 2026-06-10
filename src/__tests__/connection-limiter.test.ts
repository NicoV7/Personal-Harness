// G1 — ConnectionLimiter reliability tests (docs/RELIABILITY-TEST-GAPS.md).
//
// The limiter is the only thing standing between a multi-agent fan-out and
// the server falling over (eng review §1.5). Load-bearing invariants:
//
//   1. Permits resolve immediately while in-flight < maxInFlight.
//   2. At capacity, callers queue and resolve as permits release.
//   3. Beyond queueMax the limiter rejects with TooManyInFlightError (429).
//   4. A throwing fn still releases its permit (try/finally correctness)
//      and the queue keeps draining.
//   5. Under an N=100 storm: no deadlock, observed concurrency never
//      exceeds maxInFlight, and every call settles.
//   6. `stats` reports accurate state before/during/after load.
//
// Tests use deferred promises to hold permits open deterministically —
// no timers, no execution-order dependence between tests.

import { describe, test, expect } from "vitest";
import {
  ConnectionLimiter,
  TooManyInFlightError,
} from "../server/cache/connection-limiter.js";

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield to the microtask queue so queued waiters get a chance to run. */
async function settle(): Promise<void> {
  await new Promise<void>(r => setTimeout(r, 0));
}

describe("ConnectionLimiter — permit acquire/release flow", () => {
  test("resolves fn immediately when in-flight is below maxInFlight", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 2, queueMax: 4 });

    const result = await limiter.run(async () => "ok");

    expect(result).toBe("ok");
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 2 });
  });

  test("propagates the fn's return value for each of several sequential runs", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 1, queueMax: 4 });

    const a = await limiter.run(async () => 1);
    const b = await limiter.run(async () => 2);

    expect([a, b]).toEqual([1, 2]);
    expect(limiter.stats.inFlight).toBe(0);
  });

  test("never runs more than maxInFlight fns concurrently (instrumented counter)", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 2, queueMax: 8 });
    const gate = deferred();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      limiter.run(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent -= 1;
      });

    const all = Promise.all([task(), task(), task(), task()]);
    await settle();
    expect(concurrent).toBe(2); // two hold permits, two queued
    gate.resolve();
    await all;

    expect(maxConcurrent).toBe(2);
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 2 });
  });
});

describe("ConnectionLimiter — queueing and overflow", () => {
  test("queues callers beyond maxInFlight and resolves them as permits release", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 1, queueMax: 4 });
    const first = deferred();
    const order: string[] = [];

    const p1 = limiter.run(async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });
    const p2 = limiter.run(async () => {
      order.push("second:start");
    });

    await settle();
    expect(order).toEqual(["first:start"]); // second is parked in the queue
    expect(limiter.stats.queued).toBe(1);

    first.resolve();
    await Promise.all([p1, p2]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 1 });
  });

  test("rejects with TooManyInFlightError when the queue is full", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 1, queueMax: 1 });
    const gate = deferred();

    const holder = limiter.run(() => gate.promise); // takes the permit
    const queued = limiter.run(async () => "queued"); // fills the queue
    await settle();

    const overflow = limiter.run(async () => "overflow");
    await expect(overflow).rejects.toBeInstanceOf(TooManyInFlightError);
    await expect(overflow).rejects.toMatchObject({
      code: "too_many_in_flight",
      status: 429,
      inFlight: 1,
      queueLength: 1,
    });

    // The rejection must not corrupt the permit accounting: the queued
    // caller still drains normally once the holder releases.
    gate.resolve();
    await holder;
    await expect(queued).resolves.toBe("queued");
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 1 });
  });
});

describe("ConnectionLimiter — failure releases the permit", () => {
  test("a throwing fn releases its permit and the limiter stays usable", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 1, queueMax: 4 });

    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 1 });
    await expect(limiter.run(async () => "alive")).resolves.toBe("alive");
  });

  test("a throwing fn hands its permit to the next queued waiter (queue keeps draining)", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 1, queueMax: 4 });
    const gate = deferred();

    const failing = limiter.run(async () => {
      await gate.promise;
      throw new Error("mid-flight failure");
    });
    const waiting = limiter.run(async () => "drained");
    await settle();
    expect(limiter.stats.queued).toBe(1);

    gate.resolve();
    await expect(failing).rejects.toThrow("mid-flight failure");
    await expect(waiting).resolves.toBe("drained");
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 1 });
  });
});

describe("ConnectionLimiter — N=100 concurrent storm", () => {
  test("all 100 calls complete, no deadlock, max observed concurrency equals maxInFlight", async () => {
    const MAX_IN_FLIGHT = 4;
    const STORM_SIZE = 100;
    const limiter = new ConnectionLimiter({
      maxInFlight: MAX_IN_FLIGHT,
      queueMax: STORM_SIZE, // queue large enough that nothing 429s
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    const storm = Array.from({ length: STORM_SIZE }, (_, i) =>
      limiter.run(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        expect(concurrent).toBeLessThanOrEqual(MAX_IN_FLIGHT);
        await settle(); // hold the permit across a macrotask boundary
        concurrent -= 1;
        completed += 1;
        return i;
      }),
    );

    const results = await Promise.all(storm);

    expect(completed).toBe(STORM_SIZE);
    expect(results).toHaveLength(STORM_SIZE);
    expect(new Set(results).size).toBe(STORM_SIZE); // every call returned its own value
    expect(maxConcurrent).toBe(MAX_IN_FLIGHT); // saturated, never exceeded
    expect(limiter.stats).toEqual({
      inFlight: 0,
      queued: 0,
      maxInFlight: MAX_IN_FLIGHT,
    });
  });

  test("storm beyond queueMax: overflow rejects with 429, everything admitted still completes", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 2, queueMax: 3 });
    const gate = deferred();

    // 2 in-flight + 3 queued = 5 admitted; the rest must 429.
    const calls = Array.from({ length: 10 }, () =>
      limiter
        .run(async () => {
          await gate.promise;
          return "done" as const;
        })
        .then(
          v => ({ outcome: "ok" as const, v }),
          (e: unknown) => ({ outcome: "rejected" as const, e }),
        ),
    );
    await settle();
    gate.resolve();
    const settled = await Promise.all(calls);

    const ok = settled.filter(s => s.outcome === "ok");
    const rejected = settled.filter(s => s.outcome === "rejected");
    expect(ok).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect(r.e).toBeInstanceOf(TooManyInFlightError);
    }
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 2 });
  });
});

describe("ConnectionLimiter — stats accuracy", () => {
  test("stats reflects in-flight and queued counts before, during, and after load", async () => {
    const limiter = new ConnectionLimiter({ maxInFlight: 2, queueMax: 4 });

    // Before load
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 2 });

    const gate = deferred();
    const tasks = [
      limiter.run(() => gate.promise),
      limiter.run(() => gate.promise),
      limiter.run(() => gate.promise),
      limiter.run(() => gate.promise),
    ];
    await settle();

    // During load: 2 hold permits, 2 queued
    expect(limiter.stats).toEqual({ inFlight: 2, queued: 2, maxInFlight: 2 });

    gate.resolve();
    await Promise.all(tasks);

    // After load
    expect(limiter.stats).toEqual({ inFlight: 0, queued: 0, maxInFlight: 2 });
  });
});
