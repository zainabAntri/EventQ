import type { z } from 'zod';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  isProblemDetails,
  type ProblemDetails,
  TRACE_ID_HEADER,
} from '@eventq/contracts';
import { env } from '../env';

/**
 * The only place in the web app permitted to call fetch (enforced by the
 * no-restricted-globals rule in @eventq/config/eslint/next).
 *
 * Centralising it means credentials, error parsing and contract validation are
 * handled identically on every call, rather than being remembered correctly in
 * most places and forgotten in one.
 */

/** A failed request, carrying the machine-readable code and the trace id. */
export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly httpStatus: number,
  ) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }

  /** Branch on this, never on the message. */
  get code(): ProblemDetails['code'] {
    return this.problem.code;
  }

  /** Quote this in a bug report; it maps directly to a server-side trace. */
  get traceId(): string {
    return this.problem.traceId;
  }

  get fieldErrors(): ProblemDetails['errors'] {
    return this.problem.errors;
  }
}

/** Thrown when the server's response does not match the agreed contract. */
export class ContractViolationError extends Error {
  constructor(
    readonly path: string,
    readonly issues: z.ZodError,
  ) {
    super(`Response from ${path} did not match its contract`);
    this.name = 'ContractViolationError';
  }
}

export interface RequestOptions<TResponse extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Response schema. Validated so a backend change surfaces here, loudly. */
  schema: TResponse;
  /** Makes a submission safely retryable on unreliable venue wifi. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Forwarded cookie header, required when calling from a Server Component. */
  cookie?: string;
}

export async function apiRequest<TResponse extends z.ZodType>(
  path: string,
  options: RequestOptions<TResponse>,
): Promise<z.infer<TResponse>> {
  const url = `${env.NEXT_PUBLIC_API_URL}/api/v1${path}`;

  const method = options.method ?? 'GET';

  const headers: Record<string, string> = {
    Accept: 'application/json, application/problem+json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  // Server Components have no ambient cookie jar, so the caller forwards it.
  if (options.cookie) headers['Cookie'] = options.cookie;

  /**
   * CSRF header on every state-changing request.
   *
   * The API's AuthGuard requires this and checks it BEFORE the @Public()
   * exemption, so it is needed on the attendee endpoints too — signing a victim
   * in as the attacker, or posting a question in their name, are real attacks
   * that being unauthenticated does not make harmless.
   *
   * It works because a custom header cannot be attached to a cross-site form
   * POST at all, and a cross-origin XHR that tries must first pass a CORS
   * preflight against the API's exact origin allowlist.
   *
   * Safe methods are exempt because they must not change state anyway.
   */
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_HEADER_VALUE;

  const response = await fetch(url, {
    method,
    headers,
    // The reason the whole Vercel/AWS cookie design matters: without this the
    // session cookie is never sent and every authenticated call 401s.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw await toApiError(response, url);
  }

  if (response.status === 204) {
    return options.schema.parse(undefined) as z.infer<TResponse>;
  }

  const payload: unknown = await response.json();
  const parsed = options.schema.safeParse(payload);

  if (!parsed.success) {
    // Fail loudly rather than letting a shape mismatch propagate into the UI as
    // a confusing undefined three components deep.
    throw new ContractViolationError(path, parsed.error);
  }

  return parsed.data;
}

async function toApiError(response: Response, url: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (isProblemDetails(body)) {
    return new ApiError(body, response.status);
  }

  // A non-conforming error body means something upstream of the API failed —
  // a proxy, a load balancer, a gateway timeout. Synthesise a problem so
  // callers still only ever handle one shape.
  return new ApiError(
    {
      type: 'about:blank',
      title: response.statusText || 'Request failed',
      status: response.status,
      code: response.status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED',
      detail: `Unexpected response from ${url}`,
      traceId: response.headers.get(TRACE_ID_HEADER) ?? 'unknown',
    },
    response.status,
  );
}
