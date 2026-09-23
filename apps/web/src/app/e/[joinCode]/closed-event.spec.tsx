import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicEventResponse, PublicQuestionResponse } from '@eventq/contracts';
import { ClosedEvent } from './closed-event';

/**
 * The screen somebody reaches by scanning a poster after the event.
 *
 * The assertions that matter most are the negative ones: there must be no way
 * to ask, vote or join from here. A closed event that quietly kept a working
 * form would take questions nobody will ever read.
 */
const { listEventArchive } = vi.hoisted(() => ({ listEventArchive: vi.fn() }));

vi.mock('@/lib/api-client/public-events', () => ({ listEventArchive }));

function event(overrides: Partial<PublicEventResponse> = {}): PublicEventResponse {
  return {
    title: 'Quarterly Town Hall',
    description: null,
    venue: null,
    type: 'CORPORATE',
    joinCode: 'EVENTQ26',
    status: 'CLOSED',
    closedAt: '2026-09-16T19:30:00.000Z',
    accentColor: null,
    startsAt: null,
    endsAt: null,
    timezone: 'Europe/London',
    organizationName: 'ACME Corp',
    ...overrides,
  };
}

function question(overrides: Partial<PublicQuestionResponse> = {}): PublicQuestionResponse {
  return {
    id: '01930000-0000-7000-8000-000000000401',
    body: 'What happens to the London office lease?',
    status: 'APPROVED',
    authorName: null,
    isAnonymous: true,
    upvoteCount: 0,
    askedByCount: 1,
    isMine: false,
    hasVoted: false,
    createdAt: '2026-09-16T18:00:00.000Z',
    ...overrides,
  };
}

function page(items: PublicQuestionResponse[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

describe('ClosedEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEventArchive.mockResolvedValue(page([question()]));
  });

  it('says the event has finished', async () => {
    render(<ClosedEvent event={event()} />);

    expect(await screen.findByText(/this event has finished/i)).toBeInTheDocument();
  });

  it('shows the questions that were asked', async () => {
    render(<ClosedEvent event={event()} />);

    expect(await screen.findByText('What happens to the London office lease?')).toBeInTheDocument();
  });

  it('offers no way to ask or vote', async () => {
    render(<ClosedEvent event={event()} />);
    await screen.findByText('What happens to the London office lease?');

    // Asked through the accessibility tree, because that is what a keyboard or
    // screen-reader user actually reaches.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upvote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send question/i })).not.toBeInTheDocument();
  });

  it('reads the closing date in the event timezone, not the visitor’s', async () => {
    // 19:30 UTC on the 16th is still the 16th in London, and is already the
    // 17th in Singapore. The date an attendee remembers is the event's.
    //
    // The expected strings are built with Intl rather than hardcoded, so this
    // asserts the TIMEZONE is honoured without also asserting a date format
    // that changes with whatever locale the test machine happens to run in.
    const inLondon = expectedDate('Europe/London');
    const inSingapore = expectedDate('Asia/Singapore');
    expect(inLondon).not.toBe(inSingapore);

    render(<ClosedEvent event={event({ timezone: 'Europe/London' })} />);

    expect(await screen.findByText(new RegExp(escapeRegExp(inLondon)))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(escapeRegExp(inSingapore)))).not.toBeInTheDocument();
  });

  it('survives a timezone the runtime does not know', async () => {
    // A bad stored zone must not take down a page whose job is to show
    // questions.
    render(<ClosedEvent event={event({ timezone: 'Mars/Olympus_Mons' })} />);

    expect(await screen.findByText('What happens to the London office lease?')).toBeInTheDocument();
  });

  it('omits the date entirely when the event carries none', async () => {
    render(<ClosedEvent event={event({ closedAt: null })} />);

    expect(await screen.findByText(/no longer being taken/i)).toBeInTheDocument();
    expect(screen.queryByText(/it closed on/i)).not.toBeInTheDocument();
  });

  it('distinguishes an empty record from a failed one', async () => {
    listEventArchive.mockResolvedValue(page([]));
    render(<ClosedEvent event={event()} />);

    expect(await screen.findByText(/no questions were asked/i)).toBeInTheDocument();
  });

  it('reports a failure rather than pretending nothing was asked', async () => {
    listEventArchive.mockRejectedValue(new Error('network'));
    render(<ClosedEvent event={event()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load the questions/i);
    expect(screen.queryByText(/no questions were asked/i)).not.toBeInTheDocument();
  });

  it('loads a further page on request', async () => {
    const user = userEvent.setup();
    listEventArchive.mockResolvedValueOnce(page([question()], 'cursor-2')).mockResolvedValueOnce(
      page([
        question({
          id: '01930000-0000-7000-8000-000000000402',
          body: 'Will the hybrid policy change next year?',
        }),
      ]),
    );

    render(<ClosedEvent event={event()} />);
    await screen.findByText('What happens to the London office lease?');

    await user.click(screen.getByRole('button', { name: /show more/i }));

    await waitFor(() => {
      expect(screen.getByText('Will the hybrid policy change next year?')).toBeInTheDocument();
    });
    // The first page is still on screen: "show more" appends, it does not
    // replace.
    expect(screen.getByText('What happens to the London office lease?')).toBeInTheDocument();
  });

  it('attributes a named question and anonymises the rest', async () => {
    listEventArchive.mockResolvedValue(
      page([
        question({ authorName: 'Priya', isAnonymous: false }),
        question({ id: '01930000-0000-7000-8000-000000000403', body: 'A second question here' }),
      ]),
    );

    render(<ClosedEvent event={event()} />);

    expect(await screen.findByText(/Priya/)).toBeInTheDocument();
    expect(screen.getByText(/Anonymous/)).toBeInTheDocument();
  });

  it('shows how much support a question had', async () => {
    listEventArchive.mockResolvedValue(page([question({ upvoteCount: 12, askedByCount: 3 })]));

    render(<ClosedEvent event={event()} />);

    expect(await screen.findByText(/12 votes/)).toBeInTheDocument();
    expect(screen.getByText(/asked by 3 people/)).toBeInTheDocument();
  });
});

/** The date the component should print for a given zone, in this runtime's own
 *  locale — so the assertion is about the zone, not about the format. */
function expectedDate(timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone }).format(
    new Date('2026-09-16T19:30:00.000Z'),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
