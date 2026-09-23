import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventResponse } from '@eventq/contracts';
import { contrastRatio } from '@eventq/contracts';
import { AccentColorField } from './accent-color-field';
import { EventLifecyclePanel } from './event-lifecycle-panel';
import { QrCodeCard } from './qr-code-card';

/**
 * The organizer's half of the event experience.
 *
 * Driven through the accessibility tree throughout: an organizer setting up an
 * event minutes before a room fills is exactly the person a confusing control
 * costs the most, and roles and names are what both a screen reader and a
 * keyboard user navigate by.
 */
const { publishEvent, unpublishEvent, closeEvent, eventQrCodeUrl } = vi.hoisted(() => ({
  publishEvent: vi.fn(),
  unpublishEvent: vi.fn(),
  closeEvent: vi.fn(),
  eventQrCodeUrl: vi.fn(
    (id: string, options: { format?: string; download?: boolean } = {}) =>
      `https://api.test/api/v1/events/${id}/qr?format=${options.format ?? 'svg'}${
        options.download ? '&download=1' : ''
      }`,
  ),
}));

vi.mock('@/lib/api-client/organizer', () => ({
  publishEvent,
  unpublishEvent,
  closeEvent,
  eventQrCodeUrl,
}));

function eventFixture(overrides: Partial<EventResponse> = {}): EventResponse {
  return {
    id: '01930000-0000-7000-8000-000000000001',
    title: 'Founders and Funders Night',
    description: null,
    venue: null,
    type: 'NETWORKING',
    status: 'DRAFT',
    joinCode: 'EVENTQ26',
    joinUrl: 'https://eventq.test/e/EVENTQ26',
    slug: 'founders-and-funders-night',
    accentColor: null,
    startsAt: null,
    endsAt: null,
    timezone: 'Europe/London',
    settings: {
      accessMode: 'PUBLIC',
      moderationMode: 'PRE',
      attendeeIdentityMode: 'OPTIONAL',
      isPubliclyListed: false,
      allowUpvotes: true,
      aiEnabled: false,
    },
    organizationId: '01930000-0000-7000-8000-0000000000aa',
    publishedAt: null,
    closedAt: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('EventLifecyclePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers publishing, and only publishing, for a draft', () => {
    render(<EventLifecyclePanel event={eventFixture()} onChanged={vi.fn()} />);

    expect(screen.getByRole('button', { name: /publish event/i })).toBeInTheDocument();
    // Offering an illegal transition would let the UI ask for something the
    // server is guaranteed to refuse.
    expect(screen.queryByRole('button', { name: /close event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /return to draft/i })).not.toBeInTheDocument();
  });

  it('offers withdrawing and closing once published', () => {
    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /return to draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close event/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish event/i })).not.toBeInTheDocument();
  });

  it('offers nothing for a closed event, because closing is terminal', () => {
    render(<EventLifecyclePanel event={eventFixture({ status: 'CLOSED' })} onChanged={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /publish|close|draft/i })).not.toBeInTheDocument();
    expect(screen.getByText(/finished/i)).toBeInTheDocument();
  });

  it('publishes and hands the updated event back', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const published = eventFixture({ status: 'PUBLISHED' });
    publishEvent.mockResolvedValue(published);

    render(<EventLifecyclePanel event={eventFixture()} onChanged={onChanged} />);
    await user.click(screen.getByRole('button', { name: /publish event/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(published));
  });

  it('does not close on a single click', async () => {
    // Closing is irreversible by design. One click is too little friction.
    const user = userEvent.setup();
    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /close event/i }));

    expect(closeEvent).not.toHaveBeenCalled();
    expect(screen.getByText(/close this event for good\?/i)).toBeInTheDocument();
  });

  it('closes once confirmed', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    closeEvent.mockResolvedValue(eventFixture({ status: 'CLOSED' }));

    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={onChanged} />,
    );
    await user.click(screen.getByRole('button', { name: /close event/i }));
    await user.click(screen.getByRole('button', { name: /yes, close it/i }));

    await waitFor(() => expect(closeEvent).toHaveBeenCalledTimes(1));
  });

  it('abandons the close when cancelled', async () => {
    const user = userEvent.setup();
    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /close event/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(closeEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /close event/i })).toBeInTheDocument();
  });

  it('moves focus onto the confirmation so a keyboard user is on it', async () => {
    const user = userEvent.setup();
    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /close event/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /yes, close it/i })).toHaveFocus(),
    );
  });

  it('explains a conflict rather than inviting a pointless retry', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api-client');
    publishEvent.mockRejectedValue(
      new ApiError(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'CONFLICT',
          detail: 'The event has already moved.',
          traceId: '00000000000000000000000000000000',
        },
        409,
      ),
    );

    render(<EventLifecyclePanel event={eventFixture()} onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /publish event/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already changed/i);
  });

  it('states the status in words, not only in colour', () => {
    render(
      <EventLifecyclePanel event={eventFixture({ status: 'PUBLISHED' })} onChanged={vi.fn()} />,
    );

    // Colour alone would be invisible to anyone who cannot distinguish the
    // hues, so the word itself has to carry the state.
    expect(screen.getByText('published')).toBeInTheDocument();
  });
});

describe('QrCodeCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('describes the code for somebody who cannot see it', () => {
    render(<QrCodeCard event={eventFixture()} />);

    expect(
      screen.getByRole('img', { name: /QR code linking to the page for Founders/i }),
    ).toBeInTheDocument();
  });

  it('offers both download formats as real links', () => {
    render(<QrCodeCard event={eventFixture()} />);

    const svg = screen.getByRole('link', { name: /download svg/i });
    const png = screen.getByRole('link', { name: /download png/i });

    expect(svg).toHaveAttribute('href', expect.stringContaining('format=svg'));
    expect(svg).toHaveAttribute('href', expect.stringContaining('download=1'));
    expect(png).toHaveAttribute('href', expect.stringContaining('format=png'));
  });

  it('links to the printable poster', () => {
    render(<QrCodeCard event={eventFixture()} />);

    expect(screen.getByRole('link', { name: /printable poster/i })).toHaveAttribute(
      'href',
      '/dashboard/events/01930000-0000-7000-8000-000000000001/print',
    );
  });

  it('shows the join code and the full URL for reading aloud', () => {
    render(<QrCodeCard event={eventFixture()} />);

    expect(screen.getByText('EVENTQ26')).toBeInTheDocument();
    expect(screen.getByText('https://eventq.test/e/EVENTQ26')).toBeInTheDocument();
  });

  it('warns that a draft link will not work yet, without hiding the code', () => {
    render(<QrCodeCard event={eventFixture({ status: 'DRAFT' })} />);

    expect(screen.getByText(/will not work until the event is published/i)).toBeInTheDocument();
    // Still rendered: organizers print posters the day before, and the code
    // does not change on publish.
    expect(screen.getByRole('img', { name: /QR code/i })).toBeInTheDocument();
  });

  it('says what a scan does once the event has closed', () => {
    render(<QrCodeCard event={eventFixture({ status: 'CLOSED' })} />);

    expect(screen.getByText(/sees the questions that were asked/i)).toBeInTheDocument();
  });

  it('announces a successful copy without moving focus', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<QrCodeCard event={eventFixture()} />);
    const button = screen.getByRole('button', { name: /copy link/i });
    await user.click(button);

    expect(writeText).toHaveBeenCalledWith('https://eventq.test/e/EVENTQ26');
    expect(await screen.findByText(/copied to the clipboard/i)).toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('stays quiet when the clipboard is refused', async () => {
    // Refused over plain HTTP and in some browsers. The URL is on screen and
    // selectable either way, so this is not worth an error.
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));

    render(<QrCodeCard event={eventFixture()} />);
    await user.click(screen.getByRole('button', { name: /copy link/i }));

    expect(screen.queryByText(/copied to the clipboard/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AccentColorField', () => {
  it('hides the colour controls until branding is switched on', () => {
    render(
      <AccentColorField
        value="#4f46e5"
        onChange={vi.fn()}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /use a brand colour/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/hex code/i)).not.toBeInTheDocument();
  });

  it('offers a picker and a hex field for the same value', () => {
    render(
      <AccentColorField value="#7c3aed" onChange={vi.fn()} enabled onEnabledChange={vi.fn()} />,
    );

    expect(screen.getByLabelText(/^colour$/i)).toHaveValue('#7c3aed');
    expect(screen.getByLabelText(/hex code/i)).toHaveValue('#7c3aed');
  });

  it('reports an unusable hex code without throwing it away', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <AccentColorField value="#7c3ae" onChange={onChange} enabled onEnabledChange={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/six-digit hex colour/i);
    expect(screen.getByLabelText(/hex code/i)).toHaveAttribute('aria-invalid', 'true');

    // The bad value stays in the field so it can be corrected rather than
    // retyped from scratch.
    await user.type(screen.getByLabelText(/hex code/i), 'd');
    expect(onChange).toHaveBeenCalled();
  });

  it('says plainly when a colour had to be adjusted, and why', () => {
    // A mid-tone pink carries neither white nor near-black text at AA, so the
    // fill moves. An organizer watching their colour shift with no explanation
    // concludes the picker is broken.
    render(
      <AccentColorField value="#e61980" onChange={vi.fn()} enabled onEnabledChange={vi.fn()} />,
    );

    expect(screen.getByText(/slightly adjusted shade/i)).toBeInTheDocument();
    expect(screen.getByText(/still used for the QR code/i)).toBeInTheDocument();
  });

  it('leaves a colour that already works alone', () => {
    render(
      <AccentColorField value="#4338ca" onChange={vi.fn()} enabled onEnabledChange={vi.fn()} />,
    );

    expect(screen.queryByText(/slightly adjusted shade/i)).not.toBeInTheDocument();
  });

  it('previews a button whose label actually clears AA on it', () => {
    render(
      <AccentColorField value="#fde047" onChange={vi.fn()} enabled onEnabledChange={vi.fn()} />,
    );

    const preview = screen.getByText('Ask a question');
    const { backgroundColor, color } = preview.style;

    // Read back from the rendered style, so this fails if the component ever
    // starts using the raw accent instead of the corrected palette.
    expect(contrastRatio(toHex(color), toHex(backgroundColor))).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Replaces the clipboard.
 *
 * `navigator.clipboard` is a getter-only property in jsdom, and userEvent
 * installs its own stub during setup — so assignment fails and the stub has to
 * be defined over the top of it.
 */
function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

/** jsdom serialises inline colours as `rgb(r, g, b)`. */
function toHex(value: string): string {
  if (value.startsWith('#')) return value;

  const [r, g, b] = value.match(/\d+/gu)!.map(Number);
  return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, '0')).join('')}`;
}
