'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublicEventResponse, PublicQuestionResponse } from '@eventq/contracts';
import { Alert, Button, Spinner } from '@/components/ui';
import { listEventArchive } from '@/lib/api-client/public-events';

/**
 * What somebody sees when they scan a poster after the event has finished.
 *
 * This is the most common late scan there is: the code is photographed during
 * the event and opened on the way home, or the poster is still on a wall a week
 * later. Until now every one of those landed on "this event is not available",
 * which is both unhelpful and — for a public event whose code was on a screen
 * in front of a whole room — protecting nothing.
 *
 * ## What it shows, and what it does not
 *
 * The questions the room could already see, ranked, so the thing most people
 * cared about is first. There is no ask form, no vote button and no attendee
 * identity: the API mints no token for a closed event, because creating an
 * attendee record — and the retention clock attached to it — for somebody who
 * can no longer take part would be collecting data for nothing.
 *
 * ## Why it loads client-side when the event page renders on the server
 *
 * The event itself is server-rendered so the title and the "this finished"
 * message are in the first paint. The questions are not: they are the long,
 * paginated part, and nobody scanning a poster a week later is waiting on the
 * critical path for them. The page is useful before they arrive.
 */
export function ClosedEvent({ event }: { event: PublicEventResponse }) {
  const [questions, setQuestions] = useState<PublicQuestionResponse[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const joinCode = event.joinCode;

  useEffect(() => {
    const controller = new AbortController();

    listEventArchive(joinCode, { signal: controller.signal })
      .then((page) => {
        setQuestions(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // An empty record and a failed request must not look the same: one says
        // "nobody asked anything", the other says "try again".
        setError('We could not load the questions from this event.');
      });

    return () => controller.abort();
  }, [joinCode]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);

    try {
      const page = await listEventArchive(joinCode, { cursor });
      setQuestions((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError('We could not load any more questions.');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, joinCode]);

  return (
    <>
      <section className="mt-8 rounded-lg border border-[var(--border,#e5e5e5)] p-5">
        <h2 className="text-base font-semibold">This event has finished</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted,#666)]">
          {event.closedAt ? `It closed on ${formatDate(event.closedAt, event.timezone)}. ` : ''}
          You can still read what was asked, but new questions are no longer being taken.
        </p>
      </section>

      <section aria-labelledby="asked-heading" className="mt-8">
        <h2 id="asked-heading" className="text-sm font-semibold tracking-wide uppercase">
          What the room asked
        </h2>

        {error ? (
          <div className="mt-4">
            <Alert severity="error" title="That did not work">
              {error}
            </Alert>
          </div>
        ) : null}

        {questions === null && !error ? (
          <div className="mt-6 flex justify-center" role="status" aria-label="Loading questions">
            <Spinner className="size-5" />
          </div>
        ) : null}

        {questions?.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted,#666)]">
            No questions were asked at this event.
          </p>
        ) : null}

        {questions && questions.length > 0 ? (
          <ol className="mt-4 space-y-3">
            {questions.map((question) => (
              <li
                key={question.id}
                className="rounded-lg border border-[var(--border,#e5e5e5)] p-4"
              >
                {/* Rendered as TEXT. React escapes it — never
                    dangerouslySetInnerHTML for attendee input. */}
                <p className="text-base leading-relaxed break-words whitespace-pre-wrap">
                  {question.body}
                </p>

                <p className="mt-1.5 text-xs text-[var(--color-muted,#666)]">
                  {question.authorName ?? 'Anonymous'}
                  {question.status === 'ANSWERED' ? ' · answered' : ''}
                  {question.askedByCount > 1 ? ` · asked by ${question.askedByCount} people` : ''}
                  {question.upvoteCount > 0
                    ? ` · ${question.upvoteCount} ${question.upvoteCount === 1 ? 'vote' : 'votes'}`
                    : ''}
                </p>
              </li>
            ))}
          </ol>
        ) : null}

        {hasMore ? (
          <Button
            variant="outline"
            fullWidth
            className="mt-4"
            isLoading={isLoadingMore}
            loadingLabel="Loading more questions"
            onClick={() => void loadMore()}
          >
            Show more
          </Button>
        ) : null}
      </section>
    </>
  );
}

/**
 * The closing date in the event's own timezone.
 *
 * An event that closed at 9pm in Singapore should not read as "the 16th" to
 * someone opening the link in London — the date the attendee remembers is the
 * one the event happened on, not the one their phone is in.
 */
function formatDate(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'long',
      timeZone,
    }).format(new Date(iso));
  } catch {
    // An unknown zone must not take the page down over a date nobody needed.
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(iso));
  }
}
