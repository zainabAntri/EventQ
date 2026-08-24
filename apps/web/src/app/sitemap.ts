import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';

/**
 * Static marketing routes only.
 *
 * Publicly-listed events (Event.isPubliclyListed) will be appended here in a
 * later phase — and only those. An event is never listed unless its organizer
 * explicitly opts in.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.NEXT_PUBLIC_SITE_URL;

  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
