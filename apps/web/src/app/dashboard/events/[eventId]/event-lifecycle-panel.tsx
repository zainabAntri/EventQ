'use client';

import { useEffect, useRef, useState } from 'react';
import type { EventResponse } from '@eventq/contracts';
import { Alert, Button, LiveRegion } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { closeEvent, publishEvent, unpublishEvent } from '@/lib/api-client/organizer';

/**
 * Publishing, withdrawing and closing an event.
 *
 * The three transitions the organizer flow runs on, and the screen where a
 * draft becomes something attendees can reach.
 *
 * ## Only legal transitions are offered
 *
 * The server owns the lifecycle — DRAFT to PUBLISHED to CLOSED, with
 * unpublishing allowed only while nobody has taken part. This component asks
 * for actions rather than statuses and renders only the ones available from
 * where the event actually is, so the UI cannot request something the API will
 * refuse. Where an action is unavailable for a reason worth knowing, the reason
 * is shown instead of the button.
 *
 * ## Closing asks twice
 *
 * Closing is terminal: there is no reopening, by design, because questions
 * arriving after a room has been told the event finished is worse than making
 * someone duplicate an event. A single click is too little friction for
 * something irreversible, so it becomes a confirm/cancel pair in place. An
 * inline confirmation rather than a modal dialog, because a modal needs focus
 * trapping and an escape route to be accessible, and this needs neither.
 */
export function EventLifecyclePanel({
  event,
  onChanged,
}: {
  event: EventResponse;
  onChanged: (next: EventResponse) => void;
}) {
  const [pending, setPending] = useState<'publish' | 'unpublish' | 'close' | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus follows the confirmation into view, so a keyboard user is on the
  // button they are being asked about rather than somewhere above it.
  useEffect(() => {
    if (confirmingClose) confirmRef.current?.focus();
  }, [confirmingClose]);

  async function run(
    action: 'publish' | 'unpublish' | 'close',
    call: () => Promise<EventResponse>,
    success: string,
  ): Promise<void> {
    setPending(action);
    setError(null);

    try {
      const next = await call();
      onChanged(next);
      setAnnouncement(success);
      setConfirmingClose(false);
    } catch (caught: unknown) {
      // A 409 means the event moved underneath us — someone else in the
      // organization acted first. Saying so is more useful than "try again",
      // because trying again will fail identically until the page is reloaded.
      setError(
        caught instanceof ApiError && caught.httpStatus === 409
          ? 'The event has already changed. Reload the page to see where it is now.'
          : 'That did not work. Please try again.',
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-labelledby="lifecycle-heading"
      className="rounded-lg border border-[var(--border)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* "Event status", not "Status": a question carries a status of its
            own on every card below, and two identically-named things on one
            screen is ambiguous to anyone navigating by heading. */}
        <h2 id="lifecycle-heading" className="text-sm font-semibold">
          Event status
        </h2>
        <StatusBadge status={event.status} />
      </div>

      <p className="mt-2 text-sm text-[var(--muted)]">{describe(event)}</p>

      {error ? (
        <div className="mt-4">
          <Alert severity="error" title="That did not work">
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {event.status === 'DRAFT' ? (
          <Button
            isLoading={pending === 'publish'}
            loadingLabel="Publishing the event"
            onClick={() =>
              void run('publish', () => publishEvent(event.id), 'The event is now published.')
            }
          >
            Publish event
          </Button>
        ) : null}

        {event.status === 'PUBLISHED' ? (
          <>
            <Button
              variant="outline"
              isLoading={pending === 'unpublish'}
              loadingLabel="Returning the event to draft"
              onClick={() =>
                void run(
                  'unpublish',
                  () => unpublishEvent(event.id),
                  'The event is back to a draft.',
                )
              }
            >
              Return to draft
            </Button>

            {confirmingClose ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Close this event for good?</span>
                <Button
                  ref={confirmRef}
                  variant="danger"
                  size="sm"
                  isLoading={pending === 'close'}
                  loadingLabel="Closing the event"
                  onClick={() =>
                    void run('close', () => closeEvent(event.id), 'The event is now closed.')
                  }
                >
                  Yes, close it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmingClose(false);
                    // Focus returns where it came from. Leaving it on a button
                    // that just vanished drops a keyboard user at the top of
                    // the document.
                    closeRef.current?.focus();
                  }}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button ref={closeRef} variant="outline" onClick={() => setConfirmingClose(true)}>
                Close event
              </Button>
            )}
          </>
        ) : null}
      </div>

      {event.status === 'PUBLISHED' ? (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Returning to draft is only possible until someone takes part. After that, close the event
          instead — it keeps every question and stops new ones.
        </p>
      ) : null}

      <LiveRegion message={announcement} />
    </section>
  );
}

function StatusBadge({ status }: { status: EventResponse['status'] }) {
  // Colour is never the only signal: the word itself is the status, so this
  // reads identically to someone who cannot distinguish the hues.
  const tone: Record<EventResponse['status'], string> = {
    DRAFT: 'bg-current/10 text-[var(--muted)]',
    PUBLISHED: 'bg-green-600/15 text-green-800 dark:text-green-300',
    CLOSED: 'bg-current/10 text-[var(--foreground)]',
    ARCHIVED: 'bg-current/10 text-[var(--muted)]',
  };

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide uppercase ${tone[status]}`}
    >
      {status.toLowerCase()}
    </span>
  );
}

function describe(event: EventResponse): string {
  switch (event.status) {
    case 'DRAFT':
      return 'Only you can see this. Publishing makes the join code and QR work for attendees.';
    case 'PUBLISHED':
      return 'Attendees can scan the code and ask questions now.';
    case 'CLOSED':
      return 'Finished. Anyone who scans the code now sees the questions that were asked, and cannot add more.';
    case 'ARCHIVED':
      return 'Archived. The event is no longer reachable by its join code.';
  }
}
