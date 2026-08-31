import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QuestionResponse, QuestionStatsResponse } from '@eventq/contracts';
import { ApiError } from '@/lib/api-client';
import { ModerationConsole } from './moderation-console';
import { POLL_INTERVAL_MS } from './use-moderation-queue';

/**
 * The moderation console.
 *
 * Queries go through the accessibility tree, so a test can only pass if a
 * moderator driving this from the keyboard with a screen reader could also
 * reach the control. That matters here specifically: the queue is designed to
 * be worked at speed with Tab and Enter while a speaker is mid-sentence.
 */

const { getEvent, listQuestions, getQuestionStats, moderateQuestion, replace } = vi.hoisted(() => ({
  getEvent: vi.fn(),
  listQuestions: vi.fn(),
  getQuestionStats: vi.fn(),
  moderateQuestion: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/api-client/organizer', () => ({
  getEvent,
  listQuestions,
  getQuestionStats,
  moderateQuestion,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const EVENT_ID = '01930000-0000-7000-8000-0000000000e1';

const EVENT = {
  id: EVENT_ID,
  title: 'Founders and Funders Night',
  description: null,
  venue: null,
  type: 'NETWORKING' as const,
  status: 'PUBLISHED' as const,
  joinCode: 'H4K2M9PQ',
  joinUrl: 'https://eventq.test/e/H4K2M9PQ',
  slug: 'founders-and-funders-night',
  startsAt: null,
  endsAt: null,
  timezone: 'UTC',
  settings: {
    accessMode: 'PUBLIC' as const,
    moderationMode: 'PRE' as const,
    attendeeIdentityMode: 'OPTIONAL' as const,
    isPubliclyListed: false,
  },
  organizationId: '01930000-0000-7000-8000-0000000000a1',
  publishedAt: '2026-06-01T09:00:00.000Z',
  closedAt: null,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
};

let nextId = 0;

function question(overrides: Partial<QuestionResponse> = {}): QuestionResponse {
  nextId += 1;

  return {
    id: `01930000-0000-7000-8000-${String(nextId).padStart(12, '0')}`,
    eventId: EVENT_ID,
    body: 'How do you evaluate a founding team before the product exists?',
    status: 'PENDING',
    authorName: null,
    isAnonymous: true,
    upvoteCount: 0,
    flags: [],
    possibleDuplicateOfQuestionId: null,
    createdAt: '2026-06-01T09:30:00.000Z',
    updatedAt: '2026-06-01T09:30:00.000Z',
    answeredAt: null,
    rankScore: 1_000,
    pinnedAt: null,
    category: null,
    allowedActions: ['approve', 'reject', 'spam', 'archive'],
    ...overrides,
  };
}

function stats(overrides: Partial<QuestionStatsResponse> = {}): QuestionStatsResponse {
  return {
    counts: {
      PENDING: 2,
      APPROVED: 1,
      ANSWERED: 0,
      REJECTED: 0,
      SPAM: 0,
      ARCHIVED: 0,
    },
    total: 3,
    version: '3:1748770200000',
    ...overrides,
  };
}

function page(items: QuestionResponse[], hasMore = false) {
  return { items, nextCursor: hasMore ? 'cursor-2' : null, hasMore };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  getEvent.mockResolvedValue(EVENT);
  listQuestions.mockResolvedValue(page([question()]));
  getQuestionStats.mockResolvedValue(stats());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what a moderator can see', () => {
  it('shows the event and its join code', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(
      await screen.findByRole('heading', { name: /founders and funders night/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('H4K2M9PQ')).toBeInTheDocument();
  });

  it('shows the status, submission time, vote count and body of a question', async () => {
    listQuestions.mockResolvedValue(
      page([
        question({
          body: 'What is the biggest mistake founders make when fundraising?',
          upvoteCount: 12,
        }),
      ]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByText(/biggest mistake founders make/i)).toBeInTheDocument();

    // Scoped to the list: "Waiting" is also a tab label, so an unscoped query
    // would match the tab and prove nothing about the card.
    const list = screen.getByRole('tabpanel');
    expect(within(list).getByText('Waiting')).toBeInTheDocument();
    expect(within(list).getByText('12')).toBeInTheDocument();
    expect(within(list).getByText('votes')).toBeInTheDocument();
    // The exact timestamp stays in the markup even though the visible text is
    // relative, so it is available on hover and to anything parsing the page.
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-06-01T09:30:00.000Z');
  });

  it('shows an attendee name when one was given, and Anonymous when not', async () => {
    listQuestions.mockResolvedValue(
      page([
        question({ authorName: 'Priya Raman', isAnonymous: false }),
        question({ authorName: null, isAnonymous: true }),
      ]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByText('Priya Raman')).toBeInTheDocument();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });

  it('never shows a name on a question marked anonymous, even if one is present', async () => {
    // Belt and braces. The API already nulls the name for an anonymous
    // question, but a name leaking onto a dashboard is the kind of failure that
    // gets someone in trouble at their own event, so the UI does not rely on it.
    listQuestions.mockResolvedValue(
      page([question({ authorName: 'Priya Raman', isAnonymous: true })]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByText('Anonymous')).toBeInTheDocument();
    expect(screen.queryByText('Priya Raman')).not.toBeInTheDocument();
  });

  it('shows a category when one exists and omits it when none does', async () => {
    listQuestions.mockResolvedValue(
      page([question({ category: 'Fundraising' }), question({ category: null })]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByText('Fundraising')).toBeInTheDocument();
  });

  it('shows when a question was answered', async () => {
    listQuestions.mockResolvedValue(
      page([
        question({
          status: 'ANSWERED',
          answeredAt: '2026-06-01T10:00:00.000Z',
          allowedActions: ['approve', 'archive'],
        }),
      ]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByText(/^Answered/)).toBeInTheDocument();
  });

  it('explains why the system held a question', async () => {
    // A queue that shows SPAM without saying why is one a moderator cannot act
    // on with any confidence.
    listQuestions.mockResolvedValue(
      page([question({ status: 'SPAM', flags: ['contains_link', 'shouting'] })]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    const reasons = await screen.findByRole('list', { name: /why this question was held/i });
    expect(within(reasons).getByText(/contains a link/i)).toBeInTheDocument();
    expect(within(reasons).getByText(/mostly capitals/i)).toBeInTheDocument();
  });

  it('accounts for the order it puts questions in', async () => {
    // The transparency requirement. A ranked list that cannot explain itself is
    // one moderators stop trusting and start working around.
    listQuestions.mockResolvedValue(page([question({ upvoteCount: 9 })]));

    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.click(await screen.findByText(/why is this ranked here/i));

    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText('Recency')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText(/9 votes/)).toBeInTheDocument();
  });
});

describe('the actions on offer', () => {
  it('offers exactly the actions the API said are legal', async () => {
    listQuestions.mockResolvedValue(
      page([question({ status: 'REJECTED', allowedActions: ['restore', 'archive'] })]),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    // Restoring returns a question to the queue, not to the room, so approving
    // straight from rejected is not on offer — and the UI never works this out
    // for itself, it renders what the server permits.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers nothing on an archived question', async () => {
    listQuestions.mockResolvedValue(page([question({ status: 'ARCHIVED', allowedActions: [] })]));

    render(<ModerationConsole eventId={EVENT_ID} />);

    await screen.findByText('Archived');
    expect(
      screen.queryByRole('button', { name: /approve|restore|archive/i }),
    ).not.toBeInTheDocument();
  });

  it('sends the action and removes the question from the tab it no longer belongs to', async () => {
    const pending = question({ body: 'A question that is about to be approved by someone' });
    listQuestions.mockResolvedValue(page([pending]));
    moderateQuestion.mockResolvedValue({ ...pending, status: 'APPROVED' });

    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(moderateQuestion).toHaveBeenCalledWith(pending.id, 'approve');
    // The console opens on Waiting, so an approved question leaves the view —
    // which is what makes working a queue feel like progress.
    await waitFor(() =>
      expect(screen.queryByText(/about to be approved/i)).not.toBeInTheDocument(),
    );
  });

  it('keeps a question in place when it still belongs in the current view', async () => {
    const approved = question({
      status: 'APPROVED',
      body: 'A question that is about to be answered on stage',
      allowedActions: ['answer', 'reject', 'archive'],
    });
    listQuestions.mockResolvedValue(page([approved]));
    moderateQuestion.mockResolvedValue({
      ...approved,
      status: 'ANSWERED',
      answeredAt: '2026-06-01T10:00:00.000Z',
      allowedActions: ['approve', 'archive'],
    });

    render(<ModerationConsole eventId={EVENT_ID} />);

    // Switch to the unfiltered view, where every status belongs.
    await userEvent.click(await screen.findByRole('tab', { name: /everything/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark answered' }));

    // Scoped to the list: "Answered" is also a tab label, so an unscoped query
    // would match whichever came first and prove nothing.
    const list = await screen.findByRole('tabpanel');
    await waitFor(() => expect(within(list).getByText('Answered')).toBeInTheDocument());
    expect(within(list).getByText(/about to be answered on stage/i)).toBeInTheDocument();
  });

  it('reports a failed action without losing the question', async () => {
    listQuestions.mockResolvedValue(page([question()]));
    moderateQuestion.mockRejectedValue(
      new ApiError(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 422,
          code: 'INVALID_QUESTION_TRANSITION',
          detail: 'Someone else already archived that question.',
          traceId: 'trace-1',
        },
        422,
      ),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    // Queried by text: FormField renders an empty role="alert" slot for the
    // search box, so the role alone matches more than one node.
    expect(await screen.findByText(/already archived/i)).toBeInTheDocument();
    expect(screen.getByText(/evaluate a founding team/i)).toBeInTheDocument();
  });
});

describe('filtering, searching and sorting', () => {
  it('opens on the questions that need attention', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    await waitFor(() => expect(listQuestions).toHaveBeenCalled());
    expect(listQuestions.mock.calls[0]![1]).toMatchObject({ status: 'PENDING', sort: 'rank' });
  });

  it('shows a count on each tab', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    const waiting = await screen.findByRole('tab', { name: /waiting/i });
    expect(waiting).toHaveTextContent('2');
  });

  it('drops the status filter entirely on the unfiltered tab', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: /everything/i }));

    await waitFor(() => {
      const last = listQuestions.mock.calls.at(-1)![1];
      expect(last.status).toBeUndefined();
    });
  });

  it('moves between tabs with the arrow keys', async () => {
    // A moderator switching views forty times an hour should not have to reach
    // for a mouse, and a tablist is what makes the arrow keys work.
    render(<ModerationConsole eventId={EVENT_ID} />);

    const waiting = await screen.findByRole('tab', { name: /waiting/i });
    waiting.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: /approved/i })).toHaveFocus();
  });

  it('waits for a pause before searching, rather than querying per keystroke', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);
    await waitFor(() => expect(listQuestions).toHaveBeenCalled());

    const before = listQuestions.mock.calls.length;
    await userEvent.type(screen.getByLabelText(/search questions/i), 'runway');

    await waitFor(() =>
      expect(listQuestions.mock.calls.at(-1)![1]).toMatchObject({ search: 'runway' }),
    );

    // Six keystrokes, one query. Firing per character would run six searches
    // against the most expensive endpoint on the page to answer one question.
    expect(listQuestions.mock.calls.length - before).toBe(1);
  });

  it('does not send a search term too short for the API to accept', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);
    await waitFor(() => expect(listQuestions).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText(/search questions/i), 'a');
    // Comfortably past the debounce, so this is "it never fires" rather than
    // "it had not fired yet".
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The API rejects a one-character term rather than scanning the whole
    // event, so sending it would guarantee a 400 the moderator did not cause.
    expect(listQuestions.mock.calls.at(-1)![1].search).toBeUndefined();
  });

  it('asks the API for the chosen sort order', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.selectOptions(await screen.findByLabelText(/sort questions/i), 'votes');

    await waitFor(() =>
      expect(listQuestions.mock.calls.at(-1)![1]).toMatchObject({ sort: 'votes' }),
    );
  });
});

describe('pagination', () => {
  it('loads the next page with the cursor it was given, and appends it', async () => {
    const first = question({ body: 'The first question on the first page of the queue' });
    const second = question({ body: 'The first question on the second page of the queue' });

    listQuestions.mockResolvedValueOnce(page([first], true));
    listQuestions.mockResolvedValueOnce(page([second]));

    render(<ModerationConsole eventId={EVENT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText(/second page/i)).toBeInTheDocument());
    // Appended, not replaced: a moderator who has scrolled through four pages
    // must not lose them.
    expect(screen.getByText(/first page/i)).toBeInTheDocument();
    expect(listQuestions.mock.calls.at(-1)![1]).toMatchObject({ cursor: 'cursor-2' });
  });

  it('offers no way to load more once the list is complete', async () => {
    render(<ModerationConsole eventId={EVENT_ID} />);

    await screen.findByText(/evaluate a founding team/i);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe('staying current', () => {
  it('refreshes the counts on a poll without disturbing the list', async () => {
    vi.useFakeTimers();

    render(<ModerationConsole eventId={EVENT_ID} />);
    await vi.waitFor(() =>
      expect(screen.getByText(/evaluate a founding team/i)).toBeInTheDocument(),
    );

    const listCallsBefore = listQuestions.mock.calls.length;
    getQuestionStats.mockResolvedValue(
      stats({ counts: { ...stats().counts, PENDING: 7 }, version: '8:1748770900000' }),
    );

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);

    // Badges move immediately — they are ambient and harmless.
    await vi.waitFor(() =>
      expect(screen.getByRole('tab', { name: /waiting/i })).toHaveTextContent('7'),
    );
    // The list does NOT. Rewriting it under someone about to click Approve is
    // how a moderator approves the wrong question.
    expect(listQuestions.mock.calls.length).toBe(listCallsBefore);
  });

  it('offers a refresh when something has changed, rather than doing it unasked', async () => {
    vi.useFakeTimers();

    render(<ModerationConsole eventId={EVENT_ID} />);
    await vi.waitFor(() => expect(getQuestionStats).toHaveBeenCalled());

    getQuestionStats.mockResolvedValue(stats({ version: 'something-else' }));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);

    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /refresh the list/i })).toBeInTheDocument(),
    );
  });

  it('stops polling while the tab is hidden', async () => {
    // A laptop closed on this dashboard should not keep making a request every
    // five seconds all afternoon.
    vi.useFakeTimers();

    render(<ModerationConsole eventId={EVENT_ID} />);
    await vi.waitFor(() => expect(getQuestionStats).toHaveBeenCalled());

    const before = getQuestionStats.mock.calls.length;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(getQuestionStats.mock.calls.length).toBe(before);
  });
});

describe('a session that has expired', () => {
  it('sends the moderator to sign in, keeping where they were headed', async () => {
    listQuestions.mockRejectedValue(
      new ApiError(
        {
          type: 'about:blank',
          title: 'Unauthenticated',
          status: 401,
          code: 'UNAUTHENTICATED',
          traceId: 'trace-1',
        },
        401,
      ),
    );

    render(<ModerationConsole eventId={EVENT_ID} />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/sign-in?next=${encodeURIComponent(`/dashboard/events/${EVENT_ID}`)}`,
      ),
    );
  });
});
