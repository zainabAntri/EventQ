import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, clientIp, rateLimitSubject } from './client-ip';

const SECRET = 'proxy-secret-that-is-at-least-32-characters-long';

function fakeRequest(ip: string, headers: Record<string, string> = {}): Request {
  return { ip, headers, socket: { remoteAddress: ip } } as unknown as Request;
}

describe('clientIp', () => {
  it('believes the forwarded address when the proxy secret matches', () => {
    const request = fakeRequest('76.76.21.21', {
      [PROXY_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: '203.0.113.7',
    });

    expect(clientIp(request, SECRET)).toBe('203.0.113.7');
  });

  it('ignores the forwarded address when the secret is wrong — a direct caller cannot pick its own bucket', () => {
    const request = fakeRequest('198.51.100.9', {
      [PROXY_SECRET_HEADER]: 'guessed',
      [CLIENT_IP_HEADER]: '203.0.113.7',
    });

    expect(clientIp(request, SECRET)).toBe('198.51.100.9');
  });

  it('ignores the forwarded address when no secret is configured', () => {
    const request = fakeRequest('198.51.100.9', {
      [PROXY_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: '203.0.113.7',
    });

    expect(clientIp(request, undefined)).toBe('198.51.100.9');
  });

  it('ignores a forwarded value that is not an IP address', () => {
    const request = fakeRequest('76.76.21.21', {
      [PROXY_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: 'not-an-ip',
    });

    expect(clientIp(request, SECRET)).toBe('76.76.21.21');
  });
});

describe('rateLimitSubject', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('puts every address in one IPv6 /64 in the same bucket', () => {
    expect(rateLimitSubject('2001:db8:1:2:aaaa::1')).toBe(rateLimitSubject('2001:db8:1:2:bbbb::9'));
    expect(rateLimitSubject('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64s apart', () => {
    expect(rateLimitSubject('2001:db8:1:2::1')).not.toBe(rateLimitSubject('2001:db8:1:3::1'));
  });

  it('expands a compressed address before grouping', () => {
    expect(rateLimitSubject('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64');
  });
});
