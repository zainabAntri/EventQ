import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Who is calling, for rate limiting and session metadata.
 *
 * The problem this solves: in the free-tier deployment the browser talks to
 * Vercel, and Vercel's proxy talks to Render. With `trust proxy 1`, `req.ip` is
 * the address of the hop in front of Render — Vercel's egress — so every
 * visitor on the platform shared one rate-limit bucket. Eleven bad logins from
 * anyone locked out everyone.
 *
 * `trust proxy 2` is NOT the fix. Render is also reachable directly, and a
 * direct caller could then write any address it liked into X-Forwarded-For.
 *
 * Instead the web tier's proxy (apps/web/src/proxy.ts) forwards the client
 * address it observed in {@link CLIENT_IP_HEADER}, together with a shared
 * secret in {@link PROXY_SECRET_HEADER}. The forwarded address is believed ONLY
 * when the secret matches; anything else falls back to `req.ip`, so a direct
 * caller gains nothing by sending the header.
 */
export const CLIENT_IP_HEADER = 'x-eventq-client-ip';
export const PROXY_SECRET_HEADER = 'x-eventq-proxy-secret';

export function clientIp(request: Request, proxySecret: string | undefined): string {
  return (
    trustedForwardedIp(request, proxySecret) ??
    request.ip ??
    request.socket.remoteAddress ??
    'unknown'
  );
}

/**
 * The rate-limit subject for an address.
 *
 * IPv4 addresses are used as they are. IPv6 addresses are grouped by /64,
 * because that is the unit an ISP hands to ONE customer: keyed on the full
 * address, a single host could rotate through 2^64 fresh buckets. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the IPv4 address it wraps.
 */
export function rateLimitSubject(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;

  if (isIP(ip) !== 6) return ip;

  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
}

function trustedForwardedIp(request: Request, proxySecret: string | undefined): string | null {
  if (!proxySecret) return null;

  const presented = headerValue(request, PROXY_SECRET_HEADER);
  if (!presented || !secretsMatch(presented, proxySecret)) return null;

  const forwarded = headerValue(request, CLIENT_IP_HEADER)?.trim();
  return forwarded && isIP(forwarded) !== 0 ? forwarded : null;
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time comparison. Hashing first gives equal-length inputs, which
 *  timingSafeEqual requires, without leaking the secret's length. */
function secretsMatch(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The eight hextets of a valid IPv6 address, expanded and lower-cased. */
function ipv6Groups(ip: string): string[] {
  const address = ip.split('%')[0]!.toLowerCase();
  const [head, tail] = address.includes('::') ? address.split('::') : [address, undefined];

  const parse = (part: string | undefined): string[] =>
    part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : [];

  const left = parse(head);
  const right = parse(tail);
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');

  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16).toString(16));
}
