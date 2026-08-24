import type { ErrorCode, FieldError } from '@eventq/contracts';

/**
 * Base class for every expected failure in the system.
 *
 * Domain code throws these; it never constructs an HTTP response. A single
 * exception filter maps them to problem+json at the edge, which is what keeps
 * transport concerns out of the domain and out of controllers.
 *
 * `DomainError` is deliberately NOT a Nest HttpException — the domain layer
 * must not import the framework.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;

  /** Field-level detail, present only for validation failures. */
  readonly fieldErrors?: readonly FieldError[];

  /** Extra context for logs. Never serialised into the response body. */
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options?: {
      fieldErrors?: readonly FieldError[];
      context?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options?.fieldErrors) this.fieldErrors = options.fieldErrors;
    if (options?.context) this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — the request was understood but is not valid. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly status = 400;
}

/** 401 — no usable credentials were presented. */
export class UnauthenticatedError extends DomainError {
  readonly code: ErrorCode = 'UNAUTHENTICATED';
  readonly status = 401;
}

/** 403 — authenticated, but not permitted. */
export class ForbiddenError extends DomainError {
  readonly code: ErrorCode = 'FORBIDDEN';
  readonly status = 403;
}

/**
 * 404 — not found.
 *
 * Also used where a row exists but the caller's organization does not own it.
 * Returning 404 rather than 403 there avoids confirming that an id exists in
 * another tenant, which would otherwise be a cross-tenant enumeration oracle.
 */
export class NotFoundError extends DomainError {
  readonly code: ErrorCode = 'NOT_FOUND';
  readonly status = 404;
}

/** 409 — the request conflicts with current state. */
export class ConflictError extends DomainError {
  readonly code: ErrorCode = 'CONFLICT';
  readonly status = 409;
}

/**
 * 422 — a domain invariant was violated.
 *
 * Distinct from ValidationError: the payload was well-formed, but the operation
 * is not legal in the current state (submitting to an event that is not live,
 * merging a question into itself).
 */
export class InvariantViolationError extends DomainError {
  readonly status = 422;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ConstructorParameters<typeof DomainError>[1],
  ) {
    super(message, options);
  }
}

/** 429 — rate limited. */
export class RateLimitedError extends DomainError {
  readonly code: ErrorCode = 'RATE_LIMITED';
  readonly status = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    options?: ConstructorParameters<typeof DomainError>[1],
  ) {
    super(message, options);
  }
}

/** 503 — a dependency is unavailable. Retryable. */
export class ServiceUnavailableError extends DomainError {
  readonly code: ErrorCode = 'SERVICE_UNAVAILABLE';
  readonly status = 503;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
