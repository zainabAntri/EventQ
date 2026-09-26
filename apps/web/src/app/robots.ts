import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';

/**
 * Crawling is allowed everywhere except the raw API. Keeping private pages out
 * of search is done with `noindex`, not here, and the two must not be mixed.
 *
 * A crawler that is disallowed from a URL never fetches it, so it never sees
 * that page's `noindex`. If the URL is linked from anywhere else, such as a
 * join link posted on social media, Google can still list the bare URL. So the
 * application pages stay crawlable, and every one of them answers
 * `X-Robots-Tag: noindex` (next.config.ts) plus a `noindex` meta tag (the
 * root layout's default).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/health/'],
      },
    ],
    sitemap: `${env.NEXT_PUBLIC_SITE_URL}/sitemap.xml`,
  };
}
