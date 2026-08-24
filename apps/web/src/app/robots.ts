import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';

/**
 * Application surfaces are disallowed explicitly, in addition to the
 * X-Robots-Tag header set in next.config.ts. Belt and braces: an indexed event
 * page would expose attendee questions publicly, which is a privacy incident,
 * not merely an SEO mistake.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/e/', '/present/', '/api/'],
      },
    ],
    sitemap: `${env.NEXT_PUBLIC_SITE_URL}/sitemap.xml`,
  };
}
