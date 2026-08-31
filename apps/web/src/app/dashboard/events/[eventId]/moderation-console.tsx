'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { QuestionSort, type EventResponse, type QuestionStatsResponse } from '@eventq/contracts';
import { Alert, Button, FormField, Input, Label, LiveRegion, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { getEvent } from '@/lib/api-client/organizer';
import { cn } from '@/lib/cn';
import { QuestionCard } from './question-card';
import { useModerationQueue, type StatusFilter } from './use-moderation-queue';

/**
 * The organizer and speaker dashboard.
 *
 * Built for someone standing at the side of a room with a speaker already
 * talking, so the whole surface is one screen: tabs to choose what to look at,
 * a search box, a sort control, and a list where every question can be acted on
 * without navigating anywhere.
 *
 * It is fully keyboard-operable — the tabs are a real tablist with arrow-key
 * roving focus, and every action is a native button — because a moderator
 * working a queue at speed uses Tab and Enter, not a mouse.
 */

/** Tab order follows the workflow: what needs attention, then what has been
 *  dealt with, then the bin. */
const TABS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'PENDING', label: 'Waiting' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'ANSWERED', label: 'Answered' },
  { value: 'ALL', label: 'Everything' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'SPAM', label: 'Spam' },
  { value: 'ARCHIVED', label: 'Archived' },
];

const SORT_LABEL: Readonly<Record<QuestionSort, string>> = {
  rank: 'Best first',
  newest: 'Newest first',
  oldest: 'Oldest first',
  votes: 'Most votes',
};

export function ModerationConsole({ eventId }: { eventId: string }) {
  const router = useRouter();
  const queue = useModerationQueue(eventId);
  const [event, setEvent] = useState<EventResponse | null>(null);

  // Sent to the API only once it is long enough to be a real search, and only
  // after the typing pauses — see the debounce below.
  const [searchDraft, setSearchDraft] = useState('');

  /**
   * An expired session is the one error this screen cannot render its way out
   * of, so it navigates instead of showing a message nobody can act on.
   */
  useEffect(() => {
    if (!queue.isUnauthenticated) return;

    // Carry the destination, so signing back in returns to THIS event rather
    // than dumping a moderator on the event list mid-session.
    const next = encodeURIComponent(`/dashboard/events/${eventId}`);
    router.replace(`/sign-in?next=${next}`);
  }, [eventId, queue.isUnauthenticated, router]);

  useEffect(() => {
    const controller = new AbortController();

    getEvent(eventId, controller.signal)
      .then(setEvent)
      .catch((caught: unknown) => {
        // A 404 here means the event does not exist OR belongs to another
        // organization — the API deliberately does not distinguish them, and
        // neither does this.
        if (caught instanceof ApiError && caught.httpStatus === 404) router.replace('/dashboard');
      });

    return () => controller.abort();
  }, [eventId, router]);

  /**
   * Debounced search.
   *
   * 300ms after the last keystroke rather than on every one: search is the most
   * expensive query on the page, and firing it per character would run six
   * queries to answer one question.
   */
  const setFilters = queue.setFilters;
  useEffect(() => {
    const timer = setTimeout(() => setFilters({ search: searchDraft }), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, setFilters]);

  return (
    <main id="main" className="mx-auto max-w-4xl px-5 py-8 sm:py-10">
      <EventHeader event={event} />

      <StatusTabs
        active={queue.filters.status}
        stats={queue.stats}
        onChange={(status) => queue.setFilters({ status })}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {/* FormField owns the id and wires the label to the control — Input
              throws without it, deliberately, because a search box a screen
              reader cannot name is a search box some people cannot use. */}
          <FormField>
            <Label className="sr-only">Search questions</Label>
            <Input
              type="search"
              placeholder="Search questions…"
              value={searchDraft}
              onChange={(changed) => setSearchDraft(changed.target.value)}
            />
          </FormField>
        </div>

        <div>
          <label htmlFor="question-sort" className="sr-only">
            Sort questions
          </label>
          <select
            id="question-sort"
            className="h-11 rounded-md border border-[var(--border)] bg-transparent px-3 text-sm"
            value={queue.filters.sort}
            onChange={(changed) =>
              queue.setFilters({ sort: QuestionSort.parse(changed.target.value) })
            }
          >
            {QuestionSort.options.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABEL[sort]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {queue.hasUpdates ? (
        <div className="mt-4">
          <Alert severity="info">
            <div className="flex flex-wrap items-center gap-3">
              <span>Something has changed since this list loaded.</span>
              <Button size="sm" variant="secondary" onClick={queue.refresh}>
                Refresh the list
              </Button>
            </div>
          </Alert>
        </div>
      ) : null}

      {queue.error ? (
        <div className="mt-4">
          <Alert severity="error" title="That did not work">
            {queue.error}
          </Alert>
        </div>
      ) : null}

      <QuestionList queue={queue} />

      {/*
        Announced politely rather than assertively. A moderator using a screen
        reader is usually mid-question when a count changes, and interrupting
        them every time anyone in the room asks something makes the page
        unusable.
      */}
      <LiveRegion message={announce(queue)} />
    </main>
  );
}

function EventHeader({ event }: { event: EventResponse | null }) {
  return (
    <header>
      <p className="text-sm font-medium tracking-wide text-brand-600 uppercase">
        {event ? event.status.toLowerCase() : ' '}
      </p>

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          {event ? event.title : 'Loading…'}
        </h1>

        {event ? (
          <p className="text-sm text-[var(--muted)]">
            Join code{' '}
            <span className="font-mono font-semibold tracking-widest">{event.joinCode}</span>
          </p>
        ) : null}
      </div>
    </header>
  );
}

/**
 * The status tabs, as a real tablist.
 *
 * `role="tablist"` with roving focus rather than a row of links: a moderator
 * switching between Waiting and Approved forty times an hour should do it with
 * the arrow keys, and assistive technology should announce "tab 2 of 7" rather
 * than reading seven unrelated buttons.
 */
function StatusTabs({
  active,
  stats,
  onChange,
}: {
  active: StatusFilter;
  stats: QuestionStatsResponse | null;
  onChange: (status: StatusFilter) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number): void => {
    const next = (from + delta + TABS.length) % TABS.length;
    refs.current[next]?.focus();
    onChange(TABS[next]!.value);
  };

  return (
    <div
      role="tablist"
      aria-label="Filter questions by status"
      className="mt-6 flex flex-wrap gap-1 border-b border-[var(--border)] pb-px"
    >
      {TABS.map((tab, index) => {
        const isActive = tab.value === active;
        const count = countFor(stats, tab.value);

        return (
          <button
            key={tab.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.value}`}
            aria-selected={isActive}
            aria-controls="question-list"
            // Only the selected tab is in the tab order; the rest are reached
            // with the arrow keys. This is what "roving tabindex" means and it
            // is why a tablist does not trap a keyboard user in seven stops.
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(pressed) => {
              if (pressed.key === 'ArrowRight') {
                pressed.preventDefault();
                move(index, 1);
              }
              if (pressed.key === 'ArrowLeft') {
                pressed.preventDefault();
                move(index, -1);
              }
            }}
            onClick={() => onChange(tab.value)}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'border-b-2 border-brand-600 text-brand-700'
                : 'text-[var(--muted)] hover:bg-current/5',
            )}
          >
            {tab.label}
            {count === null ? null : (
              <span className="ml-1.5 tabular-nums" aria-hidden="true">
                {count}
              </span>
            )}
            {/* The count is repeated as words for assistive technology, since
                a bare number read after a label is ambiguous. */}
            {count === null ? null : <span className="sr-only">, {count} questions</span>}
          </button>
        );
      })}
    </div>
  );
}

function QuestionList({ queue }: { queue: ReturnType<typeof useModerationQueue> }) {
  if (queue.isLoading) {
    return (
      <div className="mt-10 flex justify-center" role="status" aria-label="Loading questions">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (queue.questions.length === 0) {
    return (
      <p
        id="question-list"
        role="tabpanel"
        aria-labelledby={`tab-${queue.filters.status}`}
        className="mt-10 text-center text-sm text-[var(--muted)]"
      >
        {queue.filters.search.trim().length >= 2
          ? 'No questions match that search.'
          : 'Nothing here yet.'}
      </p>
    );
  }

  return (
    <>
      <ul
        id="question-list"
        role="tabpanel"
        aria-labelledby={`tab-${queue.filters.status}`}
        className="mt-5 space-y-3"
      >
        {queue.questions.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            isBusy={queue.pendingActionOn === question.id}
            onModerate={(id, action) => void queue.moderate(id, action)}
          />
        ))}
      </ul>

      {queue.hasMore ? (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            isLoading={queue.isLoadingMore}
            loadingLabel="Loading more questions"
            onClick={queue.loadMore}
          >
            Load more
          </Button>
        </div>
      ) : (
        <p className="mt-6 text-center text-xs text-[var(--muted)]">
          That is every question in this view.
        </p>
      )}
    </>
  );
}

/**
 * `null` while the counts are still loading, so a tab shows nothing rather than
 * a confident zero that is about to change.
 */
function countFor(stats: QuestionStatsResponse | null, filter: StatusFilter): number | null {
  if (!stats) return null;
  if (filter === 'ALL') return stats.total;

  return stats.counts[filter] ?? 0;
}

function announce(queue: ReturnType<typeof useModerationQueue>): string {
  if (queue.isLoading) return 'Loading questions';
  if (queue.hasUpdates) return 'The queue has changed. Refresh to see the latest questions.';

  const count = queue.questions.length;
  return `${count} ${count === 1 ? 'question' : 'questions'} shown`;
}
