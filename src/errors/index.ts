// src/errors/index.ts
//
// Central typed-error classes + factories, per
// .betterai/rules/STANDARDS/error-handling/typed-errors-from-errors-layer.
//
// Code-block allocation (full table in docs/DEBUGGING.md):
//   BAI-1xx — config / bootstrap
//   BAI-2xx — auth / authz
//   BAI-3xx — contract / validation
//   BAI-4xx — retrieval / corpus
//   BAI-5xx — audit / io / resource
//
// Each class extends BetterAIError. A few retrofitted classes preserve a
// legacy observable `code`/`status` shape that existing callers + tests
// depend on; those carry the BAI identifier on `baiCode` instead. The
// observable behavior is identical to the pre-migration one-off classes.

import { BetterAIError } from "./base.js";

export { BetterAIError, toEnvelope } from "./base.js";
export type { BetterAIErrorOptions } from "./base.js";

// ---- BAI-1xx config / bootstrap -----------------------------------------

/** Base class for bearer bootstrap failures (BAI-1xx). */
export class BearerTokenError extends BetterAIError {}

/** BAI-101: the token file does not exist at the configured path. */
export class BearerTokenMissingError extends BearerTokenError {
  static readonly code = "BAI-101";
  constructor(path: string) {
    super(
      BearerTokenMissingError.code,
      `bearer token not found at ${path}; install script must write it before startup`,
    );
  }
}

/** BAI-102: the token file exists but is empty or whitespace-only. */
export class BearerTokenEmptyError extends BearerTokenError {
  static readonly code = "BAI-102";
  constructor(path: string) {
    super(
      BearerTokenEmptyError.code,
      `bearer token at ${path} is empty or whitespace-only; refusing to start with a token that matches nothing`,
    );
  }
}

/** BAI-110: `betterai gate --start` while a gate is already in progress. */
export class GateInProgressError extends BetterAIError {
  static readonly code = "BAI-110";
  constructor(
    public readonly gatePath: string,
    public readonly startedAt: string,
  ) {
    super(
      GateInProgressError.code,
      `a dogfooding gate is already in progress (started ${startedAt}, state at ${gatePath}). ` +
        `Run 'betterai gate --status' to inspect it or 'betterai gate --abort' to archive it.`,
    );
  }
}

/** BAI-111: `betterai gate --status/--abort` with no gate in progress. */
export class NoGateInProgressError extends BetterAIError {
  static readonly code = "BAI-111";
  constructor(public readonly gatePath: string) {
    super(
      NoGateInProgressError.code,
      `no dogfooding gate in progress (expected state at ${gatePath}). Run 'betterai gate --start' first.`,
    );
  }
}

// ---- BAI-3xx contract / validation --------------------------------------

/**
 * BAI-301: a request violated an input contract (MCP tool validation).
 * `httpStatus` 400 — though MCP tool handlers surface throws as isError tool
 * results, not HTTP responses; the status documents intent.
 */
export class ValidationError extends BetterAIError {
  /** Legacy wire code preserved for clients that branch on it. */
  static readonly code = "VALIDATION_ERROR";
  /** Stable BAI identifier (canonical `code` keeps the legacy string). */
  static readonly baiCode = "BAI-301";
  readonly baiCode = ValidationError.baiCode;
  constructor(message: string) {
    super(ValidationError.code, message, { httpStatus: 400 });
  }
}

// ---- BAI-4xx retrieval / corpus -----------------------------------------

/** BAI-401: an explain_rule lookup found no matching rule in scope. */
export class RuleNotFoundError extends BetterAIError {
  /** Legacy wire code preserved for clients that branch on it. */
  static readonly code = "RULE_NOT_FOUND";
  /** Stable BAI identifier (canonical `code` keeps the legacy string). */
  static readonly baiCode = "BAI-401";
  readonly baiCode = RuleNotFoundError.baiCode;
  constructor(message: string) {
    super(RuleNotFoundError.code, message, { httpStatus: 404 });
  }
}

// ---- BAI-5xx audit / io / resource --------------------------------------

/**
 * BAI-501: any filesystem failure the audit writer hits (EACCES/EISDIR/
 * ENOENT/ENOSPC/...).
 *
 * OBSERVABLE-SHAPE CONTRACT (unchanged from the pre-migration class):
 *   - `.code` is the underlying ERRNO string (e.g. "EACCES"), or null.
 *   - `.path` is the audit path the failed op targeted.
 *   - `.cause` carries the original errno error.
 * The BAI identifier lives on `.baiCode` so the errno surface is preserved
 * for callers/tests that branch on syscall codes.
 */
export class AuditIoError extends BetterAIError {
  static readonly baiCode = "BAI-501";
  /** The underlying errno code (e.g. "EACCES", "EISDIR"), if known. */
  override readonly code: string | null;
  /** The audit path the failed operation targeted. */
  readonly path: string;
  /** Stable BAI identifier (the canonical `code` is shadowed by errno above). */
  readonly baiCode = AuditIoError.baiCode;

  constructor(msg: string, opts: { path: string; cause?: unknown }) {
    super(AuditIoError.baiCode, msg, { httpStatus: 500, cause: opts.cause });
    this.path = opts.path;
    const cause = opts.cause as NodeJS.ErrnoException | undefined;
    this.code = typeof cause?.code === "string" ? cause.code : null;
  }
}

/** BAI-502: an audit event failed the parent-session invariant at emit time. */
export class AuditValidationError extends BetterAIError {
  static readonly code = "BAI-502";
  constructor(msg: string) {
    super(AuditValidationError.code, msg);
  }
}

/**
 * BAI-510: the connection limiter overflowed (queue full).
 *
 * OBSERVABLE-SHAPE CONTRACT (unchanged): `.code === "too_many_in_flight"`,
 * `.status === 429`. The BAI identifier is on `.baiCode`.
 */
export class TooManyInFlightError extends BetterAIError {
  static readonly baiCode = "BAI-510";
  override readonly code = "too_many_in_flight";
  readonly status = 429;
  readonly baiCode = TooManyInFlightError.baiCode;
  constructor(
    public readonly inFlight: number,
    public readonly queueLength: number,
  ) {
    super(TooManyInFlightError.baiCode, `connection limiter overflow: ${inFlight} in-flight, ${queueLength} queued`, {
      httpStatus: 429,
    });
  }
}

// ---- Factories -----------------------------------------------------------
//
// Per the rule, error messages are constructed via factories carrying the
// canonical message + code. Callers may also `new` a class directly where
// that reads clearer (e.g. errors with structured fields like AuditIoError).

export const Errors = {
  bearerTokenMissing: (path: string) => new BearerTokenMissingError(path),
  bearerTokenEmpty: (path: string) => new BearerTokenEmptyError(path),
  gateInProgress: (gatePath: string, startedAt: string) =>
    new GateInProgressError(gatePath, startedAt),
  noGateInProgress: (gatePath: string) => new NoGateInProgressError(gatePath),
  validation: (message: string) => new ValidationError(message),
  ruleNotFound: (message: string) => new RuleNotFoundError(message),
  auditValidation: (message: string) => new AuditValidationError(message),
  auditIo: (message: string, opts: { path: string; cause?: unknown }) =>
    new AuditIoError(message, opts),
  tooManyInFlight: (inFlight: number, queueLength: number) =>
    new TooManyInFlightError(inFlight, queueLength),
} as const;
