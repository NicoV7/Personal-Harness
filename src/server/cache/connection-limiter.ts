// src/server/cache/connection-limiter.ts
//
// In-flight concurrency limiter for retrieve_* calls.
//
// Per the multi-agent eng review §1.5: a workflow can fan out dozens of
// subagents that all hit MCP simultaneously.  We cap concurrent in-flight
// retrievals at 16 and queue beyond.  If the queue grows past
// `queueMax`, we reject with HTTP 429 (Too Many Requests) so the caller
// can retry with backoff.
//
// This is intentionally a primitive semaphore, not a fancy scheduler —
// retrievals are short (sub-200ms typical), the queue drains fast, and
// 429 is the right pressure-release for the rare overflow case.

import {
  LIMITER_DEFAULT_MAX_IN_FLIGHT,
  LIMITER_DEFAULT_QUEUE_MAX,
} from "./constants.js";

export class TooManyInFlightError extends Error {
  readonly code = "too_many_in_flight";
  readonly status = 429;
  constructor(public readonly inFlight: number, public readonly queueLength: number) {
    super(
      `connection limiter overflow: ${inFlight} in-flight, ${queueLength} queued`,
    );
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface ConnectionLimiterOptions {
  /** Maximum concurrent in-flight calls. Default: 16 (eng review §1.5). */
  maxInFlight?: number;
  /** Maximum queued waiters; beyond this we throw 429. Default: 64. */
  queueMax?: number;
}

export class ConnectionLimiter {
  private readonly maxInFlight: number;
  private readonly queueMax: number;
  private inFlight = 0;
  private readonly queue: Waiter[] = [];

  constructor(opts: ConnectionLimiterOptions = {}) {
    this.maxInFlight = opts.maxInFlight ?? LIMITER_DEFAULT_MAX_IN_FLIGHT;
    this.queueMax = opts.queueMax ?? LIMITER_DEFAULT_QUEUE_MAX;
  }

  /**
   * Acquire a permit; runs `fn` with the permit held and releases on
   * success or failure.  If the queue is full, throws TooManyInFlightError
   * immediately (the caller — typically the HTTP handler — should return
   * 429 with no body or a structured error).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueMax) {
      throw new TooManyInFlightError(this.inFlight, this.queue.length);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit straight to the next waiter; don't decrement.
      next.resolve();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get stats(): { inFlight: number; queued: number; maxInFlight: number } {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      maxInFlight: this.maxInFlight,
    };
  }
}
