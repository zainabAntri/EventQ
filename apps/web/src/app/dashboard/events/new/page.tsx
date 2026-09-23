import type { Metadata } from 'next';
import { CreateEventForm } from './create-event-form';

/**
 * Shell for the create-event form.
 *
 * A Server Component that renders a Client Component and nothing else, matching
 * the rest of the dashboard: the form needs the session cookie the browser
 * already holds, and there is nothing here for a search engine.
 */
export const metadata: Metadata = {
  title: 'New event',
  robots: { index: false, follow: false },
};

export default function NewEventPage() {
  return <CreateEventForm />;
}
