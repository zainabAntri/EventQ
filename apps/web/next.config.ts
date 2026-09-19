import type { NextConfig } from 'next';

/**
 * Security headers are set here rather than at the CDN so they live in version
 * control, get code-reviewed, and cannot drift between environments.
 *
 * The API sets its own headers via helmet; these cover the pages Vercel serves.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // The attendee flow needs the camera for QR scanning on the device itself;
    // everything else is denied outright.
    value: 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The monorepo package ships compiled JS, so Next does not need to transpile
  // it — but it must be traced for the standalone output.
  transpilePackages: ['@eventq/contracts'],

  typescript: {
    // A type error must fail the build. Shipping around one defeats the point
    // of the strict config.
    ignoreBuildErrors: false,
  },

  // No `eslint` key: Next 16 removed it (it warns "Unrecognized key"). Linting
  // is its own CI step, which is better anyway — a lint failure is then
  // attributable to lint rather than buried in build output.

  /**
   * Same-origin proxy for the API.
   *
   * The auth cookies are SameSite=Lax and host-only (see the API's
   * auth.cookies.ts), so the browser only sends them when the API appears on
   * the SAME origin as the pages. When API_PROXY_TARGET is set, Next forwards
   * /api/v1/* and /health/* there and NEXT_PUBLIC_API_URL is this site's own
   * origin. Locally it is unset and the browser calls :4000 directly.
   *
   * Server-only on purpose: the browser never needs to know where the API
   * really lives.
   */
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    if (!target) return [];
    return [
      { source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` },
      { source: '/health/:path*', destination: `${target}/health/:path*` },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // The application surfaces must never be indexed. An indexed event page
        // would expose attendee questions to search engines, which is a privacy
        // incident rather than an SEO problem.
        source: '/:path(e|app|present)/:rest*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;
