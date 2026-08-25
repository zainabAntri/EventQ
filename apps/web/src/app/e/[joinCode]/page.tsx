import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { getPublicEvent } from '@/lib/api-client/public-events';
import { AskForm } from './ask-form';

/**
 * The page an attendee lands on after scanning the QR code.
 *
 * A Server Component that fetches the event and renders it, with the form as
 * the only client component. The event details are therefore in the first
 * paint — no spinner, no layout shift — which matters because this is opened on
 * mobile data in a crowded venue and every round trip before the textarea
 * appears is a person giving up.
 *
 * `noindex` is enforced twice, in next.config.ts and robots.ts. That is a
 * privacy control rather than an SEO preference: an indexed event page would
 * publish attendee questions to search engines.
 */
export const metadata: Metadata = {
  title: 'Ask a question',
  robots: { index: false, follow: false },
};

/** Always fetched fresh: an event can be closed between two people scanning. */
export const dynamic = 'force-dynamic';

export default async function AttendeeEventPage({
  params,
}: {
  params: Promise<{ joinCode: string }>;
}) {
  const { joinCode } = await params;
  const event = await loadEvent(joinCode);

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col px-5 py-8 sm:py-12">
      <p className="text-sm font-medium tracking-wide text-brand-600 uppercase">
        {event.organizationName}
      </p>

      <h1 className="mt-2 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
        {event.title}
      </h1>

      {event.venue ? (
        <p className="mt-2 text-sm text-[var(--color-muted,#666)]">{event.venue}</p>
      ) : null}

      {event.description ? (
        <p className="mt-4 text-base leading-relaxed text-[var(--color-muted,#666)]">
          {/* Rendered as TEXT. React escapes it, which is the control that
              actually prevents XSS — never dangerouslySetInnerHTML here. */}
          {event.description}
        </p>
      ) : null}

      <AskForm joinCode={event.joinCode} />

      <p className="mt-8 text-xs text-[var(--color-muted,#666)]">
        No account needed. Your question is sent anonymously unless you add your name.
      </p>
    </main>
  );
}

/**
 * Loads the event, turning every "you may not see this" into one 404.
 *
 * Unknown code, draft, closed, archived and private are indistinguishable by
 * design — the API returns the same 404 for all of them, and this page must not
 * undo that by rendering a different page for one of them. Anything else would
 * let someone probe for valid join codes from a browser.
 */
async function loadEvent(joinCode: string) {
  try {
    return await getPublicEvent(joinCode);
  } catch (caught) {
    if (caught instanceof ApiError && caught.httpStatus === 404) notFound();
    throw caught;
  }
}
