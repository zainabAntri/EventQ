'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthenticatedOrganizer, EventResponse } from '@eventq/contracts';
import { Alert, Button, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { getCurrentOrganizer, listEvents, signOut } from '@/lib/api-client/organizer';

/**
 * The events an organizer can moderate.
 *
 * Deliberately thin: creating and configuring events already has an API, but no
 * screen, and building one here would be a second feature wearing this phase's
 * name. This lists what exists and gets someone into a console.
 */
export function EventList() {
  const router = useRouter();
  const [organizer, setOrganizer] = useState<AuthenticatedOrganizer | null>(null);
  const [events, setEvents] = useState<EventResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    Promise.all([getCurrentOrganizer(controller.signal), listEvents(controller.signal)])
      .then(([session, page]) => {
        if (cancelled) return;
        setOrganizer(session.organizer);
        setEvents(page.items);
      })
      .catch((caught: unknown) => {
        if (cancelled || (caught instanceof DOMException && caught.name === 'AbortError')) return;

        // No usable session: there is nothing to render and nothing to explain,
        // so send them somewhere they can do something about it.
        if (caught instanceof ApiError && caught.httpStatus === 401) {
          router.replace('/sign-in?next=/dashboard');
          return;
        }

        setError('We could not load your events. Please try again.');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [router]);

  return (
    <main id="main" className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Your events</h1>
          {organizer ? (
            <p className="mt-1 text-sm text-[var(--muted)]">
              {organizer.organization.name} · {organizer.organization.role.toLowerCase()}
            </p>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Navigate regardless of the outcome: the API clears the cookies
            // even for an already-expired session, and a failure here must not
            // leave someone stuck on a page they meant to leave.
            void signOut().finally(() => router.replace('/sign-in'));
          }}
        >
          Sign out
        </Button>
      </div>

      {error ? (
        <div className="mt-6">
          <Alert severity="error" title="That did not work">
            {error}
          </Alert>
        </div>
      ) : null}

      {events === null && !error ? (
        <div className="mt-10 flex justify-center" role="status" aria-label="Loading events">
          <Spinner className="size-6" />
        </div>
      ) : null}

      {events?.length === 0 ? (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">You have no events yet.</p>
      ) : null}

      {events && events.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {events.map((event) => (
            <li key={event.id}>
              <Link
                href={`/dashboard/events/${event.id}`}
                className="block rounded-lg border border-[var(--border)] p-4 transition-colors hover:bg-current/5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{event.title}</span>
                  <span className="text-xs tracking-wide text-[var(--muted)] uppercase">
                    {event.status.toLowerCase()}
                  </span>
                </div>

                <p className="mt-1 text-sm text-[var(--muted)]">
                  Join code <span className="font-mono tracking-widest">{event.joinCode}</span>
                  {event.venue ? ` · ${event.venue}` : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
