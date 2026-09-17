import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicQuestionResponse } from '@eventq/contracts';
import { ApiError } from '@/lib/api-client';
import { AttendeeSessionProvider } from './attendee-session';
import { QuestionBoard } from './question-board';

/**
 * The board, driven through the accessibility tree.
 *
 * The vote button is a toggle (`aria-pressed`), so every test that checks "has
 * this person voted" asks the same question a screen reader would. If the
 * pressed state and the visual state ever disagree, these fail.
 */
const { joinEvent, listPublicQuestions, castVote, withdrawVote } = vi.hoisted(() => ({
  joinEvent: vi.fn(),
  listPublicQuestions: vi.fn(),
  castVote: vi.fn(),
  withdrawVote: vi.fn(),
}));

vi.mock('@/lib/api-client/public-events', () => ({
  joinEvent,
  listPublicQuestions,
  castVote,
  withdrawVote,
}));

const SESSION = {
  attendeeId: '01930000-0000-7000-8000-000000000301',
  displayName: null,
  identityMode: 'OPTIONAL' as const,
  moderationMode: 'PRE' as const,
  allowUpvotes: true,
  limits: {
    minQuestionLength: 10,
    maxQuestionLength: 500,
    submitLimitCount: 5,
    submitLimitWindowSeconds: 60,
  },
};

function question(overrides: Partial<PublicQuestionResponse> = {}): PublicQuestionResponse {
  return {
    id: '01930000-0000-7000-8000-000000000401',
    body: 'How do you keep a professional network warm?',
    status: 'APPROVED',
    authorName: 'Priya Raman',
    isAnonymous: false,
    upvoteCount: 8,
    isMine: false,
    hasVoted: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

function page(items: PublicQuestionResponse[]) {
  return { items, nextCursor: null, hasMore: false };
}

function renderBoard() {
  return render(
    <AttendeeSessionProvider joinCode="EVENTQ26">
      <QuestionBoard joinCode="EVENTQ26" />
    </AttendeeSessionProvider>,
  );
}

function problem(code: string, status: number) {
  return new ApiError(
    {
      type: `https://docs.eventq.io/errors/${code.toLowerCase()}`,
      title: code,
      status,
      code: code as never,
      traceId: 'trace-1',
    },
    status,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  joinEvent.mockResolvedValue(SESSION);
  listPublicQuestions.mockResolvedValue(page([question()]));
});

describe('the board', () => {
  it('lists the questions once the identity exists', async () => {
    renderBoard();

    expect(
      await screen.findByText('How do you keep a professional network warm?'),
    ).toBeInTheDocument();
    // Joined exactly once for the page, and only then asked for the list.
    expect(joinEvent).toHaveBeenCalledTimes(1);
    expect(listPublicQuestions).toHaveBeenCalledWith('EVENTQ26', expect.anything());
  });

  it('labels the vote button with the count and reports the voted state', async () => {
    listPublicQuestions.mockResolvedValue(page([question({ upvoteCount: 8, hasVoted: true })]));
    renderBoard();

    const button = await screen.findByRole('button', { name: /upvote, 8 votes/i });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('says nothing has been asked when the board is empty', async () => {
    listPublicQuestions.mockResolvedValue(page([]));
    renderBoard();

    expect(await screen.findByText(/nothing has been asked yet/i)).toBeInTheDocument();
  });
});

describe('voting', () => {
  it('casts a vote and shows the count the server returned', async () => {
    castVote.mockResolvedValue({
      questionId: '01930000-0000-7000-8000-000000000401',
      upvoteCount: 9,
      hasVoted: true,
    });
    const user = userEvent.setup();
    renderBoard();

    await user.click(await screen.findByRole('button', { name: /upvote, 8 votes/i }));

    const button = await screen.findByRole('button', { name: /upvote, 9 votes/i });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(castVote).toHaveBeenCalledWith('EVENTQ26', '01930000-0000-7000-8000-000000000401');
    expect(withdrawVote).not.toHaveBeenCalled();
  });

  it('withdraws a vote that was already cast', async () => {
    listPublicQuestions.mockResolvedValue(page([question({ upvoteCount: 9, hasVoted: true })]));
    withdrawVote.mockResolvedValue({
      questionId: '01930000-0000-7000-8000-000000000401',
      upvoteCount: 8,
      hasVoted: false,
    });
    const user = userEvent.setup();
    renderBoard();

    await user.click(await screen.findByRole('button', { name: /upvote, 9 votes/i }));

    const button = await screen.findByRole('button', { name: /upvote, 8 votes/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(withdrawVote).toHaveBeenCalledTimes(1);
  });

  it('sends one request for a double tap', async () => {
    let release: (value: unknown) => void = () => {};
    castVote.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const user = userEvent.setup();
    renderBoard();

    const button = await screen.findByRole('button', { name: /upvote, 8 votes/i });
    await user.click(button);
    await user.click(button);

    expect(castVote).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    release({ questionId: '01930000-0000-7000-8000-000000000401', upvoteCount: 9, hasVoted: true });
  });

  it('does not change the count when the vote fails', async () => {
    castVote.mockRejectedValue(problem('RATE_LIMITED', 429));
    const user = userEvent.setup();
    renderBoard();

    await user.click(await screen.findByRole('button', { name: /upvote, 8 votes/i }));

    expect(await screen.findByText(/voting very quickly/i)).toBeInTheDocument();
    // No optimistic jump to 9 and back: the count never left 8.
    expect(screen.getByRole('button', { name: /upvote, 8 votes/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('hides the vote buttons when the organizer switched voting off', async () => {
    joinEvent.mockResolvedValue({ ...SESSION, allowUpvotes: false });
    renderBoard();

    await screen.findByText('How do you keep a professional network warm?');
    expect(screen.queryByRole('button', { name: /upvote/i })).not.toBeInTheDocument();
    // The count is still shown — the room can see support, it just cannot add to it.
    expect(screen.getByText(/8 votes/)).toBeInTheDocument();
  });

  it('offers no vote button on the attendee’s own question while it is waiting', async () => {
    listPublicQuestions.mockResolvedValue(
      page([question({ status: 'PENDING', isMine: true, authorName: null })]),
    );
    renderBoard();

    const item = await screen.findByText('How do you keep a professional network warm?');
    expect(within(item.closest('li')!).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for a moderator/i)).toBeInTheDocument();
  });
});

describe('resilience', () => {
  it('shows a quiet message rather than a broken list when loading fails', async () => {
    listPublicQuestions.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderBoard();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('retries the join when the background join failed', async () => {
    joinEvent.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderBoard();

    // The provider's mount join fails, and the board's first load shares that
    // failure. Coming back to the tab — the commonest thing a phone does —
    // triggers a fresh load, which joins again and gets through. Nothing
    // dead-ends on one lost request.
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(joinEvent).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('How do you keep a professional network warm?'),
    ).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no serious violations', async () => {
    const { container } = renderBoard();
    await screen.findByText('How do you keep a professional network warm?');

    await expect(container).toHaveNoSeriousA11yViolations();
  });
});
