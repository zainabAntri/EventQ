import { NextResponse, type NextRequest } from 'next/server';

/**
 * Tells the API who the real client is.
 *
 * In the deployed setup the browser calls this site, and next.config.ts
 * rewrites /api/v1/* and /health/* to the API. To the API, every one of those
 * requests comes from this site's servers — so without this, every visitor
 * shared ONE rate-limit bucket, and ten bad logins from anyone locked out
 * everyone.
 *
 * So for exactly those paths, this forwards the client address the platform
 * observed, plus a shared secret proving the header came from here. The API
 * believes the address only when the secret matches (apps/api/src/shared/http/
 * client-ip.ts). Headers set here reach the rewrite destination: the proxy runs
 * before next.config.ts rewrites.
 *
 * Both headers are always stripped from the incoming request first, so a
 * client can never supply its own.
 */
const CLIENT_IP_HEADER = 'x-eventq-client-ip';
const PROXY_SECRET_HEADER = 'x-eventq-proxy-secret';

export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(PROXY_SECRET_HEADER);

  const secret = process.env.API_PROXY_SHARED_SECRET;
  const ip = observedClientIp(request);
  if (secret && ip) {
    headers.set(CLIENT_IP_HEADER, ip);
    headers.set(PROXY_SECRET_HEADER, secret);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/api/v1/:path*', '/health/:path*'],
};

/**
 * Vercel's edge sets `x-real-ip` and `x-forwarded-for` itself, overwriting any
 * value the client sent, so on Vercel these name the actual caller. Elsewhere
 * (locally) neither is trustworthy — but locally there is no secret either, so
 * nothing is forwarded.
 */
function observedClientIp(request: NextRequest): string | undefined {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
}
