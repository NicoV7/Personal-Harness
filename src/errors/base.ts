// src/errors/base.ts
//
// The base of the central errors layer, per
// .betterai/rules/STANDARDS/error-handling/typed-errors-from-errors-layer.
//
// Every typed error in BetterAI extends `BetterAIError`, which carries:
//   - `code: string`   — a stable BAI-* identifier (see docs/DEBUGGING.md for
//                        the code-block allocation). Clients/dashboards match
//                        on the code even when the human message drifts.
//   - `httpStatus?`    — the wire status a transport handler maps it to.
//   - `cause?`         — the underlying error, when wrapping a third-party throw.
//
// Some retrofitted errors expose an ADDITIONAL legacy `code` shape that
// existing callers/tests depend on (e.g. AuditIoError surfaces the errno
// string on `.code`, TooManyInFlightError surfaces "too_many_in_flight").
// Those keep their observable `code` and stash the BAI identifier on
// `baiCode` instead — see each subclass. New code should read `baiCode`
// (or, for greenfield errors, the canonical `code`).

export interface BetterAIErrorOptions {
  /** HTTP/wire status a handler maps this error to. */
  httpStatus?: number;
  /** Underlying error when wrapping a third-party/system throw. */
  cause?: unknown;
}

export class BetterAIError extends Error {
  /**
   * Stable BAI-* error code. Non-null for every greenfield error; a couple of
   * retrofitted subclasses (AuditIoError) override `code` with a legacy
   * `string | null` errno shape and stash the BAI id on `baiCode` — hence the
   * union here. Read `baiCode` when you need the guaranteed BAI identifier.
   */
  readonly code: string | null;
  /** Optional wire status for transport handlers. */
  readonly httpStatus?: number;

  constructor(code: string, message: string, opts: BetterAIErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.httpStatus = opts.httpStatus;
    // `new.target.name` so subclasses report their own class name without
    // each having to set `this.name` by hand.
    this.name = new.target.name;
  }
}

/**
 * Map a typed error to the canonical wire envelope: `{ error, message }`.
 * One place builds the shape so handlers never inline `c.json({error:...})`.
 */
export function toEnvelope(err: BetterAIError): { error: string; message: string } {
  // `code` is null only for the retrofitted errno-bearing subclasses; fall back
  // to the BAI identifier (`baiCode`) when present so the envelope always has a
  // stable string.
  const baiCode = (err as { baiCode?: string }).baiCode;
  return { error: err.code ?? baiCode ?? "BAI-000", message: err.message };
}
