import type { Metadata } from 'next';
import { PrintPoster } from './print-poster';

/**
 * Shell for the printable poster.
 *
 * Like the rest of the dashboard, the work happens in a Client Component: the
 * event is fetched with the session cookie the browser already holds, and
 * `window.print()` needs a browser anyway.
 */
export const metadata: Metadata = {
  title: 'Printable poster',
  robots: { index: false, follow: false },
};

export default async function PrintPosterPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  return <PrintPoster eventId={eventId} />;
}
