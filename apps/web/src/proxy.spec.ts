// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

// Wire names, spelled out: they must match apps/api/src/shared/http/client-ip.ts.
const CLIENT_IP_HEADER = 'x-eventq-client-ip';
const PROXY_SECRET_HEADER = 'x-eventq-proxy-secret';
const SECRET = 'proxy-secret-that-is-at-least-32-characters-long';

/** Next exposes request headers set by a proxy as `x-middleware-request-<name>`
 *  on the response; that is how they reach the rewrite destination. */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function apiRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://event-q-web.vercel.app/api/v1/auth/login', {
    method: 'POST',
    headers,
  });
}

describe('proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('forwards the observed client IP with the shared secret', () => {
    vi.stubEnv('API_PROXY_SHARED_SECRET', SECRET);

    const response = proxy(apiRequest({ 'x-real-ip': '203.0.113.7' }));

    expect(forwarded(response, CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(forwarded(response, PROXY_SECRET_HEADER)).toBe(SECRET);
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    vi.stubEnv('API_PROXY_SHARED_SECRET', SECRET);

    const response = proxy(apiRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));

    expect(forwarded(response, CLIENT_IP_HEADER)).toBe('203.0.113.7');
  });

  it("replaces a client's own attempt to set the headers", () => {
    vi.stubEnv('API_PROXY_SHARED_SECRET', SECRET);

    const response = proxy(
      apiRequest({
        'x-real-ip': '203.0.113.7',
        [CLIENT_IP_HEADER]: '198.51.100.1',
        [PROXY_SECRET_HEADER]: 'forged',
      }),
    );

    expect(forwarded(response, CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(forwarded(response, PROXY_SECRET_HEADER)).toBe(SECRET);
  });

  it('forwards nothing when no secret is configured, and still strips client-supplied values', () => {
    vi.stubEnv('API_PROXY_SHARED_SECRET', '');

    const response = proxy(
      apiRequest({ 'x-real-ip': '203.0.113.7', [CLIENT_IP_HEADER]: '198.51.100.1' }),
    );

    expect(forwarded(response, CLIENT_IP_HEADER)).toBeNull();
    expect(forwarded(response, PROXY_SECRET_HEADER)).toBeNull();
    expect(response.headers.get('x-middleware-override-headers')).not.toContain(CLIENT_IP_HEADER);
  });
});
