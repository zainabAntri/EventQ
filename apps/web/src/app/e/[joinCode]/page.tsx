import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { getPublicEvent } from '@/lib/api-client/public-events';
import { AskForm } from './ask-form';
import { AttendeeSessionProvider } from './attendee-session';
import { ClosedEvent } from './closed-event';
import { EventBranding } from './event-branding';
import { QuestionBoard } from './question-board';

/**
 * The page an attendee lands on after scanning the QR code.
 *
 * A Server Component that fetches the event and renders it, with the form as
 * the only client component. The event details are therefore in the first
 * paint — no spinner, no layout shift — which matters because this is opened on
 * mobile data in a crowded venue and every round trip before the textarea
 * appears is a person giving up.
 *
 * ## Two shapes, one route
 *
 * A published event gets the question form and the live board. A closed one
 * gets the record of what was asked and no way to add to it. They share this
 * route rather than redirecting, because the URL is printed on a poster: it
 * cannot change meaning depending on when somebody scans it, and a redirect
 * would put a second address into the world that the poster does not carry.
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
  const isClosed = event.status === 'CLOSED';

  return (
    <EventBranding accentColor={event.accentColor}>
      <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col px-5 py-8 sm:py-12">
        <p className="text-sm font-medium tracking-wide text-[var(--event-accent-ink,var(--color-brand-600))] uppercase">
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

        {isClosed ? (
          // No AttendeeSessionProvider: a closed event issues no token, and
          // wrapping this would have the page ask for one on mount and fail.
          <ClosedEvent event={event} />
        ) : (
          /* One identity for the whole page. The form and the board both need
             it, and each joining on its own would mint two attendees. */
          <AttendeeSessionProvider joinCode={event.joinCode}>
            <AskForm joinCode={event.joinCode} />

            <p className="mt-8 text-xs text-[var(--color-muted,#666)]">
              No account needed. Your question is sent anonymously unless you add your name.
            </p>

            <QuestionBoard joinCode={event.joinCode} />
          </AttendeeSessionProvider>
        )}
      </main>
    </EventBranding>
  );
}

/**
 * Loads the event, turning "you may not see this" into one 404.
 *
 * The API distinguishes exactly one previously-hidden case: a public event that
 * was published and has since closed, which is disclosed because its join code
 * was displayed to a whole room. Everything else — unknown code, draft,
 * archived, private — is still one indistinguishable 404, and this page must
 * not undo that by rendering something different for one of them.
 */
async function loadEvent(joinCode: string) {
  try {
    return await getPublicEvent(joinCode);
  } catch (caught) {
    if (caught instanceof ApiError && caught.httpStatus === 404) notFound();
    throw caught;
  }
}
