import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, TRACE_ID_HEADER } from '@eventq/contracts';
import { ApiError, ContractViolationError, apiRequest } from './index';

/**
 * Contract tests for the API client.
 *
 * Verifies the two guarantees the rest of the frontend depends on:
 *   1. every failure arrives as an ApiError with a usable `code` and `traceId`
 *   2. a response that does not match its contract fails LOUDLY here, rather
 *      than propagating as an undefined three components deep
 */

const Thing = z.object({ id: z.string(), title: z.string() });

function mockFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('sends credentials so the session cookie crosses to the API origin', async () => {
    const spy = mockFetch(jsonResponse({ id: '1', title: 'Ok' }));

    await apiRequest('/things/1', { schema: Thing });

    // Without credentials:'include' the whole Vercel/AWS cookie design fails
    // and every authenticated call 401s.
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('returns parsed data when the response matches its contract', async () => {
    mockFetch(jsonResponse({ id: '1', title: 'Ok' }));

    await expect(apiRequest('/things/1', { schema: Thing })).resolves.toEqual({
      id: '1',
      title: 'Ok',
    });
  });

  it('throws ContractViolationError when the server drifts from the contract', async () => {
    // `title` is missing — a backend change that would otherwise surface as a
    // confusing render bug far from its cause.
    mockFetch(jsonResponse({ id: '1' }));

    await expect(apiRequest('/things/1', { schema: Thing })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('turns problem+json into an ApiError carrying code and traceId', async () => {
    mockFetch(
      jsonResponse(
        {
          type: 'https://docs.eventq.io/errors/event_not_live',
          title: 'Event Not Live',
          status: 422,
          code: 'EVENT_NOT_LIVE',
          detail: 'This event is not accepting questions.',
          traceId: 'trace-123',
        },
        { status: 422, headers: { 'Content-Type': PROBLEM_CONTENT_TYPE } },
      ),
    );

    const error = await apiRequest('/things', { method: 'POST', schema: Thing }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    // Clients branch on `code`, never on the human-facing `detail`.
    expect(apiError.code).toBe('EVENT_NOT_LIVE');
    expect(apiError.traceId).toBe('trace-123');
  });

  it('exposes field errors so a form can map them back onto inputs', async () => {
    mockFetch(
      jsonResponse(
        {
          type: 'https://docs.eventq.io/errors/validation_failed',
          title: 'Validation Failed',
          status: 400,
          code: 'VALIDATION_FAILED',
          traceId: 't-1',
          errors: [{ path: 'body', message: 'Question is too short' }],
        },
        { status: 400, headers: { 'Content-Type': PROBLEM_CONTENT_TYPE } },
      ),
    );

    const error = (await apiRequest('/things', { method: 'POST', schema: Thing }).catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error.fieldErrors).toEqual([{ path: 'body', message: 'Question is too short' }]);
  });

  it('synthesises a problem when a proxy returns a non-conforming error', async () => {
    // A gateway timeout is HTML, not problem+json. Callers must still only ever
    // handle one error shape.
    mockFetch(
      new Response('<html>504 Gateway Timeout</html>', {
        status: 504,
        headers: { 'Content-Type': 'text/html', [TRACE_ID_HEADER]: 'edge-9' },
      }),
    );

    const error = (await apiRequest('/things/1', { schema: Thing }).catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.httpStatus).toBe(504);
  });

  it('attaches an idempotency key when given one', async () => {
    const spy = mockFetch(jsonResponse({ id: '1', title: 'Ok' }));

    await apiRequest('/things', {
      method: 'POST',
      schema: Thing,
      body: { title: 'Ok' },
      idempotencyKey: 'key-abc',
    });

    // Venue wifi drops requests constantly; a retried submission must not
    // create a second question.
    const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-abc');
  });
});
