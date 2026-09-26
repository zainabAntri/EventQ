import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';

/**
 * Indexable pages only, which today means the landing page.
 *
 * No event is listed. Event pages carry attendee questions, and the organizer
 * opt-in that would make one public (`Event.isPubliclyListed`) has no UI yet.
 * Until it does, every event page is `noindex` and stays out of this file.
 *
 * No `lastModified`: stamping `new Date()` on every request tells crawlers the
 * page changed when it did not, which teaches them to ignore the field.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: env.NEXT_PUBLIC_SITE_URL, changeFrequency: 'monthly', priority: 1 }];
}
