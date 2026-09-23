'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublicQuestionResponse } from '@eventq/contracts';
import { Button, LiveRegion, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { castVote, listPublicQuestions, withdrawVote } from '@/lib/api-client/public-events';
import { cn } from '@/lib/cn';
import { useAttendeeSession } from './attendee-session';

/**
 * The board: what the room has asked, and a way to say "me too".
 *
 * Voting is the reason this exists. A question board a room cannot react to is
 * a suggestion box; one it can vote on tells the speaker what the room most
 * wants answered, which is the thing the organizer's ranking is built from.
 *
 * ---------------------------------------------------------------------------
 * Why this polls, and why it polls slowly
 * ---------------------------------------------------------------------------
 *
 * Every phone in the room holds this page open for an hour, so the cost of
 * each refresh is multiplied by the audience. Ten seconds is the point where
 * a question approved on stage appears "soon enough" for someone glancing
 * down at their phone, without a room of eight hundred people producing a
 * request per second between them. The dashboard polls faster because there
 * are three of it, not eight hundred. Polling stops while the tab is hidden,
 * which on a phone is most of the time.
 *
 * The board also reloads immediately when THIS device submits a question, so
 * the attendee sees it waiting without having to wonder whether it went.
 *
 * ---------------------------------------------------------------------------
 * Votes are applied from the server's answer, not guessed
 * ---------------------------------------------------------------------------
 *
 * Tapping the button sends the request and shows the count the server
 * returns. There is no optimistic increment: on venue wifi a request can take
 * a couple of seconds, and a count that jumps up, then jumps back because the
 * request failed, is worse than one that takes a moment. The button is
 * disabled while its request is in flight, which is also what stops a double
 * tap from becoming two requests — although the server would treat the second
 * as a no-op anyway.
 */

export const BOARD_POLL_INTERVAL_MS = 10_000;

export function QuestionBoard({ joinCode }: { joinCode: string }) {
  const { session, ensureSession, boardVersion } = useAttendeeSession();
  const [questions, setQuestions] = useState<PublicQuestionResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The question whose vote request is in flight, so its button can wait. */
  const [votingOn, setVotingOn] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  /**
   * Loads page one. Runs once the identity exists — the list endpoint needs
   * the attendee cookie — and again whenever this device submits a question.
   */
  const loadFirstPage = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        await ensureSession();
        const page = await listPublicQuestions(joinCode, signal ? { signal } : {});
        if (signal?.aborted) return;

        setQuestions(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // Quiet: the board is secondary to asking. A banner over the list for
        // a transient blip on venue wifi would be noise, and the next poll is
        // ten seconds away.
        setError('The question list could not be loaded. It will retry shortly.');
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [ensureSession, joinCode],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage, boardVersion]);

  // The poller. Page one only: anyone who has paged further is reading, and
  // rewriting their list underneath them would lose their place.
  //
  // Deliberately NOT gated on the session existing. If the join failed, this
  // is the only thing that will try again — a first version waited for the
  // session before polling, which meant one lost request on arrival left the
  // board empty for the rest of the event.
  useEffect(() => {
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadFirstPage();
    };

    const interval = setInterval(tick, BOARD_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadFirstPage]);

  const loadMore = useCallback((): void => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);

    listPublicQuestions(joinCode, { cursor })
      .then((page) => {
        setQuestions((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch(() => setError('More questions could not be loaded right now.'))
      .finally(() => setIsLoadingMore(false));
  }, [cursor, isLoadingMore, joinCode]);

  const toggleVote = useCallback(
    async (question: PublicQuestionResponse): Promise<void> => {
      if (votingOn) return;
      setVotingOn(question.id);
      setError(null);

      try {
        const result = question.hasVoted
          ? await withdrawVote(joinCode, question.id)
          : await castVote(joinCode, question.id);

        // The server's count, not ours: it is the only one that has seen every
        // other phone in the room.
        setQuestions((current) =>
          current.map((item) =>
            item.id === result.questionId
              ? { ...item, upvoteCount: result.upvoteCount, hasVoted: result.hasVoted }
              : item,
          ),
        );
        setAnnouncement(
          result.hasVoted
            ? `Vote added. ${result.upvoteCount} ${result.upvoteCount === 1 ? 'vote' : 'votes'}.`
            : `Vote removed. ${result.upvoteCount} ${result.upvoteCount === 1 ? 'vote' : 'votes'}.`,
        );
      } catch (caught) {
        setError(voteErrorFor(caught));
      } finally {
        setVotingOn(null);
      }
    },
    [joinCode, votingOn],
  );

  // Hidden entirely, not disabled, when the organizer switched voting off: a
  // row of buttons that do nothing invites tapping and then confusion.
  const canVote = session?.allowUpvotes ?? true;

  return (
    <section aria-labelledby="board-heading" className="mt-10">
      <h2 id="board-heading" className="text-lg font-semibold">
        Questions from the room
      </h2>

      {error ? (
        <p role="status" className="mt-2 text-sm text-[var(--color-muted,#666)]">
          {error}
        </p>
      ) : null}

      {isLoading ? (
        <div className="mt-6 flex justify-center" role="status" aria-label="Loading questions">
          <Spinner className="size-5" />
        </div>
      ) : questions.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-muted,#666)]">
          Nothing has been asked yet. Yours could be first.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {questions.map((question) => (
            <BoardItem
              key={question.id}
              question={question}
              canVote={canVote}
              isBusy={votingOn === question.id}
              onToggleVote={() => void toggleVote(question)}
            />
          ))}
        </ul>
      )}

      {hasMore ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            isLoading={isLoadingMore}
            loadingLabel="Loading more questions"
            onClick={loadMore}
          >
            Show more
          </Button>
        </div>
      ) : null}

      <LiveRegion message={announcement} />
    </section>
  );
}

function BoardItem({
  question,
  canVote,
  isBusy,
  onToggleVote,
}: {
  question: PublicQuestionResponse;
  canVote: boolean;
  isBusy: boolean;
  onToggleVote: () => void;
}) {
  // Only what the room can see can be voted on. An attendee's own question
  // that is still waiting is shown to them, but there is nothing to support
  // yet — the server would refuse it with a 404 anyway.
  const isLive = question.status === 'APPROVED' || question.status === 'ANSWERED';

  return (
    <li
      className={cn(
        'flex gap-3 rounded-lg border border-[var(--border,#e5e5e5)] p-4',
        question.isMine && 'border-[var(--event-accent-fill,var(--color-brand-500))]/40',
      )}
    >
      <div className="min-w-0 flex-1">
        {/* Rendered as TEXT. React escapes it — never dangerouslySetInnerHTML
            for attendee input. */}
        <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{question.body}</p>

        <p className="mt-1.5 text-xs text-[var(--color-muted,#666)]">
          {question.isMine ? 'You' : (question.authorName ?? 'Anonymous')}
          {question.isMine && question.status === 'PENDING' ? ' · waiting for a moderator' : ''}
          {question.status === 'ANSWERED' ? ' · answered' : ''}
          {question.askedByCount > 1 ? ` · asked by ${question.askedByCount} people` : ''}
        </p>
      </div>

      {canVote && isLive ? (
        <button
          type="button"
          // aria-pressed makes this a toggle to assistive technology: "Upvote,
          // pressed" reads as "you have voted", which is exactly the state.
          aria-pressed={question.hasVoted}
          aria-label={`Upvote, ${question.upvoteCount} ${question.upvoteCount === 1 ? 'vote' : 'votes'}`}
          disabled={isBusy}
          aria-busy={isBusy || undefined}
          onClick={onToggleVote}
          className={cn(
            // 48px minimum on both axes: pressed one-handed, standing, in a
            // dim room. Smaller targets are how people vote for the wrong one.
            'flex min-h-12 min-w-14 shrink-0 flex-col items-center justify-center rounded-lg border px-2 text-sm font-semibold tabular-nums transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            // Branded through variables rather than fixed brand classes, so an
            // event's accent reaches the control the room actually presses.
            // Both colours come from the same corrected palette, so a voted
            // button can never end up with unreadable digits on it.
            question.hasVoted
              ? 'border-[var(--event-accent-fill,var(--color-brand-600))] bg-[var(--event-accent-fill,var(--color-brand-600))] text-[var(--event-on-accent,#fff)]'
              : 'border-[var(--border,#e5e5e5)] hover:bg-current/5',
            isBusy && 'opacity-60',
          )}
        >
          <span aria-hidden="true">▲</span>
          <span aria-hidden="true">{question.upvoteCount}</span>
        </button>
      ) : isLive ? (
        <p className="shrink-0 self-center text-sm tabular-nums text-[var(--color-muted,#666)]">
          {question.upvoteCount} {question.upvoteCount === 1 ? 'vote' : 'votes'}
        </p>
      ) : null}
    </li>
  );
}

/** Branches on `code`, never on wording — the message text is not a contract. */
function voteErrorFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return 'That vote did not reach the server. Check your connection and try again.';
  }

  switch (caught.code) {
    case 'RATE_LIMITED':
      return 'You are voting very quickly. Please wait a moment.';
    case 'VOTING_DISABLED':
      return 'Voting has been switched off for this event.';
    case 'EVENT_NOT_LIVE':
      return 'This event has finished.';
    case 'ATTENDEE_BLOCKED':
      return 'You are no longer able to take part in this event.';
    case 'NOT_FOUND':
      return 'That question is no longer on the board.';
    case 'UNAUTHENTICATED':
      return 'Your session expired. Please reload the page.';
    default:
      return 'That vote did not go through. Please try again.';
  }
}
