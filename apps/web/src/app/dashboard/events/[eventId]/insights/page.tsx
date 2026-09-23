import type { Metadata } from 'next';
import { EventInsights } from './event-insights';

/**
 * Shell for Event Insights.
 *
 * Like the rest of the dashboard, the work happens in a Client Component that
 * fetches with the session cookie the browser already holds. `noindex` for the
 * same reason as the moderation page: this shows attendee questions.
 */
export const metadata: Metadata = {
  title: 'Event insights',
  robots: { index: false, follow: false },
};

export default async function EventInsightsPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  return <EventInsights eventId={eventId} />;
}
