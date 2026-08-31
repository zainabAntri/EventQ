import type { Metadata } from 'next';
import { EventList } from './event-list';

/**
 * The organizer's events.
 *
 * The way in to a moderation console, and the first screen after signing in.
 * Like the console it renders client-side: it is behind a login, has nothing to
 * say to a search engine, and needs the session cookie the browser already
 * holds.
 */
export const metadata: Metadata = {
  title: 'Your events',
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return <EventList />;
}
