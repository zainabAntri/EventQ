'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  QuestionModerationAction,
  QuestionResponse,
  QuestionSort,
  QuestionStatsResponse,
  QuestionStatus,
} from '@eventq/contracts';
import { ApiError } from '@/lib/api-client';
import { getQuestionStats, listQuestions, moderateQuestion } from '@/lib/api-client/organizer';

/**
 * The moderation queue's data layer.
 *
 * ---------------------------------------------------------------------------
 * Why this polls instead of holding a stream open
 * ---------------------------------------------------------------------------
 *
 * A moderation queue does not need sub-second delivery. A question arriving
 * five seconds late is invisible to the person working through the list, and
 * the machinery that would shave those seconds off — an SSE endpoint, Redis
 * fan-out so it works with more than one API instance, per-connection auth,
 * per-event subscription checks, heartbeats, and something to reap connections
 * that died without saying so — is a permanent operational commitment.
 *
 * So this polls a deliberately cheap endpoint instead. `/questions/stats` is
 * one grouped count over an indexed column; it returns the tab badges the
 * dashboard needs anyway, plus a `version` token that moves whenever anything
 * about the event's questions changes. The expensive list query runs only when
 * that token moves.
 *
 * Polling also stops entirely when the tab is hidden, which a stream cannot do
 * without tearing down and re-establishing the connection.
 *
 * ---------------------------------------------------------------------------
 * Why an update does not replace the list on its own
 * ---------------------------------------------------------------------------
 *
 * When the token moves, this raises a flag rather than swapping the list out.
 * Rewriting the list under someone who is halfway through reading a question —
 * or worse, a moment before they click Approve on it — is how a moderator
 * approves the wrong thing. The count badges update live because they are
 * ambient; the list changes only when the moderator asks it to.
 */

export const POLL_INTERVAL_MS = 5_000;
export const PAGE_SIZE = 25;

/** `ALL` is the absence of a status filter, not a status. */
export type StatusFilter = QuestionStatus | 'ALL';

export interface QueueFilters {
  status: StatusFilter;
  search: string;
  sort: QuestionSort;
}

export const DEFAULT_FILTERS: QueueFilters = {
  // Pending first: it is the only tab with work waiting in it, and opening the
  // dashboard on anything else means a moderator's first action is a click that
  // tells them nothing.
  status: 'PENDING',
  search: '',
  sort: 'rank',
};

export interface ModerationQueue {
  questions: QuestionResponse[];
  stats: QuestionStatsResponse | null;
  filters: QueueFilters;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  /** Something changed on the server that this list does not yet reflect. */
  hasUpdates: boolean;
  /** The id currently being acted on, so one card can show a busy state. */
  pendingActionOn: string | null;
  error: string | null;
  /** The session has expired or was never valid. The page redirects on this. */
  isUnauthenticated: boolean;
  setFilters: (update: Partial<QueueFilters>) => void;
  loadMore: () => void;
  refresh: () => void;
  moderate: (questionId: string, action: QuestionModerationAction) => Promise<void>;
}

export function useModerationQueue(eventId: string): ModerationQueue {
  const [questions, setQuestions] = useState<QuestionResponse[]>([]);
  const [stats, setStats] = useState<QuestionStatsResponse | null>(null);
  const [filters, setFiltersState] = useState<QueueFilters>(DEFAULT_FILTERS);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [hasUpdates, setHasUpdates] = useState(false);
  const [pendingActionOn, setPendingActionOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUnauthenticated, setIsUnauthenticated] = useState(false);

  /**
   * The version the currently displayed list was built from.
   *
   * A ref rather than state because the poller reads it on every tick and
   * putting it in state would make the poller's effect depend on it, tearing
   * down and rebuilding the interval on every change.
   */
  const loadedVersion = useRef<string | null>(null);

  /** Bumped to force a reload of page one. */
  const [reloadToken, setReloadToken] = useState(0);

  const handleFailure = useCallback((caught: unknown): void => {
    if (caught instanceof DOMException && caught.name === 'AbortError') return;

    if (caught instanceof ApiError && caught.httpStatus === 401) {
      setIsUnauthenticated(true);
      return;
    }

    setError(
      caught instanceof ApiError
        ? (caught.problem.detail ?? caught.problem.title)
        : 'Something went wrong loading the queue.',
    );
  }, []);

  const queryFor = useCallback(
    (current: QueueFilters) => ({
      ...(current.status === 'ALL' ? {} : { status: current.status }),
      // The API rejects a one-character term rather than scanning the event, so
      // a half-typed search is simply not sent yet.
      ...(current.search.trim().length >= 2 ? { search: current.search.trim() } : {}),
      sort: current.sort,
      limit: PAGE_SIZE,
    }),
    [],
  );

  // Page one, plus the counts. Re-runs whenever the filters change or something
  // asks for a refresh.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    Promise.all([
      listQuestions(eventId, queryFor(filters), controller.signal),
      getQuestionStats(eventId, controller.signal),
    ])
      .then(([page, counts]) => {
        if (cancelled) return;

        setQuestions(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setStats(counts);
        // The list and this token were fetched together, so the list is current
        // as of this version and the poller has nothing to report yet.
        loadedVersion.current = counts.version;
        setHasUpdates(false);
      })
      .catch((caught: unknown) => {
        if (!cancelled) handleFailure(caught);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [eventId, filters, queryFor, reloadToken, handleFailure]);

  /**
   * The poller.
   *
   * Counts are applied immediately — a badge changing under someone is
   * harmless and genuinely useful. The list is left alone; only the flag moves.
   */
  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      // Nothing is watching a hidden tab, and a laptop closed on a dashboard
      // should not keep a request every five seconds running all afternoon.
      if (typeof document !== 'undefined' && document.hidden) return;

      try {
        const counts = await getQuestionStats(eventId);
        if (cancelled) return;

        setStats(counts);
        if (loadedVersion.current !== null && counts.version !== loadedVersion.current) {
          setHasUpdates(true);
        }
      } catch (caught) {
        // A failed poll is not worth an error banner: the next one is five
        // seconds away, and a transient blip during an event should not cover
        // the queue with a message. An expired session still needs acting on.
        if (caught instanceof ApiError && caught.httpStatus === 401) setIsUnauthenticated(true);
      }
    };

    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);

    // Catch up immediately when someone comes back to the tab, rather than
    // showing them stale counts for up to a full interval.
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [eventId]);

  const setFilters = useCallback((update: Partial<QueueFilters>): void => {
    setFiltersState((current) => {
      const next = { ...current, ...update };
      // Referential equality matters here: the loading effect depends on the
      // filters object, so returning a new one for an identical filter would
      // refetch on every keystroke that changes nothing.
      const unchanged =
        next.status === current.status &&
        next.search === current.search &&
        next.sort === current.sort;

      return unchanged ? current : next;
    });
  }, []);

  const refresh = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  const loadMore = useCallback((): void => {
    if (!cursor || isLoadingMore) return;

    setIsLoadingMore(true);

    listQuestions(eventId, { ...queryFor(filters), cursor })
      .then((page) => {
        // Appended, never merged by id: the cursor guarantees this page starts
        // exactly where the last one ended, so a duplicate here would mean the
        // pagination itself is broken and hiding it would be the wrong repair.
        setQuestions((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch(handleFailure)
      .finally(() => setIsLoadingMore(false));
  }, [cursor, eventId, filters, isLoadingMore, queryFor, handleFailure]);

  const moderate = useCallback(
    async (questionId: string, action: QuestionModerationAction): Promise<void> => {
      setPendingActionOn(questionId);
      setError(null);

      try {
        const updated = await moderateQuestion(questionId, action);

        setQuestions((current) => {
          /**
           * A question that no longer belongs in the current view leaves it.
           *
           * On a filtered tab that is the whole point: approving from the
           * pending queue should clear the item you just dealt with. Archived
           * questions leave even the unfiltered view, because the API excludes
           * them there too — keeping one would show a row that a refresh would
           * then silently remove.
           */
          const stillBelongs =
            updated.status !== 'ARCHIVED' &&
            (filters.status === 'ALL' || updated.status === filters.status);

          return stillBelongs
            ? current.map((question) => (question.id === questionId ? updated : question))
            : current.filter((question) => question.id !== questionId);
        });

        /**
         * Adopt the new version so this change does not announce itself back as
         * "someone else changed something".
         *
         * The honest caveat: if another moderator commits a change inside the
         * few hundred milliseconds this request takes, that change is absorbed
         * into the same token and no banner appears for it. The window is
         * small, the cost is one missed prompt to refresh, and the alternative —
         * flagging every action a moderator takes themselves — would train them
         * to ignore the banner entirely.
         */
        const counts = await getQuestionStats(eventId);
        setStats(counts);
        loadedVersion.current = counts.version;
        setHasUpdates(false);
      } catch (caught) {
        handleFailure(caught);
      } finally {
        setPendingActionOn(null);
      }
    },
    [eventId, filters.status, handleFailure],
  );

  return {
    questions,
    stats,
    filters,
    isLoading,
    isLoadingMore,
    hasMore,
    hasUpdates,
    pendingActionOn,
    error,
    isUnauthenticated,
    setFilters,
    loadMore,
    refresh,
    moderate,
  };
}
