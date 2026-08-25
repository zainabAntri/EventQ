import { z } from 'zod';

/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API contract: clients branch on `code`, never on
 * `detail` (which is human-facing and may be reworded or localised at any time).
 */
export const ErrorCode = z.enum([
  // Generic
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',

  // Auth
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_ALREADY_REGISTERED',
  'TOKEN_EXPIRED',
  'TOKEN_REUSE_DETECTED',
  'ACCOUNT_LOCKED',

  // Events
  'EVENT_NOT_LIVE',
  'EVENT_NOT_FOUND',
  'JOIN_CODE_TAKEN',
  'INVALID_EVENT_TRANSITION',

  // Questions
  'QUESTION_TOO_LONG',
  'QUESTION_TOO_SHORT',
  /** This attendee already asked this exact question on this event. */
  'DUPLICATE_QUESTION',
  'DUPLICATE_VOTE',
  'EDIT_WINDOW_CLOSED',
  'ATTENDEE_BLOCKED',
  'IDENTITY_REQUIRED',
  'SUBMISSION_LIMIT_REACHED',
  'INVALID_QUESTION_TRANSITION',
  'CANNOT_MERGE_INTO_SELF',

  // AI — never fatal to a request; surfaced for observability
  'AI_DISABLED',
  'AI_BUDGET_EXCEEDED',
  'AI_PROVIDER_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** One field-level validation failure. */
export const FieldError = z.object({
  /** Dot/bracket path to the offending field, e.g. `settings.maxQuestionLength`. */
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type FieldError = z.infer<typeof FieldError>;

/**
 * RFC 9457 problem details — the ONLY error shape this API emits.
 *
 * `traceId` is present on every response so a user-reported failure maps
 * directly to a distributed trace without asking them to reproduce it.
 */
export const ProblemDetails = z.object({
  /** URI reference identifying the problem type. */
  type: z.string(),
  /** Short human-readable summary. Stable per `code`. */
  title: z.string(),
  /** HTTP status code, repeated in the body per RFC 9457. */
  status: z.number().int(),
  /** Machine-readable code. Branch on this, never on `detail`. */
  code: ErrorCode,
  /** Human-readable explanation for THIS occurrence. May change; do not parse. */
  detail: z.string().optional(),
  /** The request path that produced the problem. */
  instance: z.string().optional(),
  /** Correlation id, also present as a response header. */
  traceId: z.string(),
  /** Present only for VALIDATION_FAILED. */
  errors: z.array(FieldError).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Type guard for narrowing an unknown rejection to a problem response. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  return ProblemDetails.safeParse(value).success;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Response header carrying the correlation id. */
export const TRACE_ID_HEADER = 'x-trace-id';

/** Request header that makes a submission safely retryable on flaky venue wifi. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
