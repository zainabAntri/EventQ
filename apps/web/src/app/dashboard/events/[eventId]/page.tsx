import type { Metadata } from 'next';
import { ModerationConsole } from './moderation-console';

/**
 * Shell for the moderation console.
 *
 * A Server Component that does nothing but unwrap the route parameter. The
 * console itself is a Client Component and fetches everything it needs with the
 * session cookie attached, which is the simplest arrangement that works across
 * the Vercel/AWS origin split: the browser already holds the cookie, and no
 * request has to be forwarded by hand.
 *
 * `noindex` is not an SEO preference here. Attendee questions, including ones
 * no moderator has approved yet, are the most sensitive content in the product
 * and must never reach a search index.
 */
export const metadata: Metadata = {
  title: 'Moderation',
  robots: { index: false, follow: false },
};

export default async function EventDashboardPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  return <ModerationConsole eventId={eventId} />;
}
