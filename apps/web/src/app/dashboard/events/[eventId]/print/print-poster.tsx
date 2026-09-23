'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { brandPalette, type EventResponse } from '@eventq/contracts';
import { Alert, Button, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { eventQrCodeUrl, getEvent } from '@/lib/api-client/organizer';

/**
 * The poster an organizer prints and puts on a wall.
 *
 * ## Designed for paper, previewed on screen
 *
 * Everything that is not the poster — the toolbar, the guidance — carries
 * `print:hidden`, so what comes out of the printer is the poster alone. The
 * sheet itself is sized in millimetres rather than pixels or rems, because A4
 * is a physical object and a QR code that renders at "16rem" is at the mercy of
 * the browser's print scaling.
 *
 * ## Why the QR is enormous
 *
 * Scanning distance scales with the size of the code. A code that fills a
 * phone screen beautifully is unreadable from four metres away, which is where
 * people actually stand in a room. The code here takes most of the sheet, and
 * the join code is printed underneath in large type as the fallback for anyone
 * whose camera will not cooperate — or who is reading it from the back.
 *
 * ## Colour and print
 *
 * The QR uses the organizer's exact accent, already corrected server-side to at
 * least 7:1 against white so a scanner can read it. Everything else on the
 * sheet is near-black on white: coloured body text costs ink, and some printers
 * render mid-tones as mush.
 */
export function PrintPoster({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [event, setEvent] = useState<EventResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    getEvent(eventId, controller.signal)
      .then(setEvent)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;

        if (caught instanceof ApiError && caught.httpStatus === 401) {
          router.replace(
            `/sign-in?next=${encodeURIComponent(`/dashboard/events/${eventId}/print`)}`,
          );
          return;
        }

        setError('We could not load this event.');
      });

    return () => controller.abort();
  }, [eventId, router]);

  if (error) {
    return (
      <main id="main" className="mx-auto max-w-xl px-5 py-12">
        <Alert severity="error" title="That did not work">
          {error}
        </Alert>
      </main>
    );
  }

  if (!event) {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6" />
        <span className="sr-only">Loading the event</span>
      </main>
    );
  }

  const palette = brandPalette(event.accentColor);

  return (
    <>
      <div className="print:hidden">
        <div className="mx-auto flex max-w-[210mm] flex-wrap items-center justify-between gap-3 px-5 pt-6">
          <Link
            href={`/dashboard/events/${event.id}`}
            className="text-sm text-[var(--muted)] underline underline-offset-4"
          >
            Back to the event
          </Link>

          <Button onClick={() => window.print()}>Print this poster</Button>
        </div>

        {event.status === 'DRAFT' ? (
          <div className="mx-auto mt-4 max-w-[210mm] px-5">
            <Alert severity="warning" title="This event is still a draft">
              The code below will not work for attendees until you publish. It does not change when
              you publish, so printing now is safe.
            </Alert>
          </div>
        ) : null}
      </div>

      {/*
        One A4 sheet. `print:` variants collapse the on-screen chrome and let
        the sheet fill the page; the explicit millimetre sizing keeps the layout
        identical in the preview and on paper.
      */}
      <main
        id="main"
        className="mx-auto my-6 flex h-[297mm] w-[210mm] max-w-full flex-col items-center justify-between bg-white px-[15mm] py-[18mm] text-center text-black shadow-sm print:my-0 print:h-auto print:min-h-screen print:shadow-none"
      >
        <header className="w-full">
          <p className="text-[4mm] font-semibold tracking-[0.2em] uppercase">
            {event.title ? 'Questions welcome' : ''}
          </p>

          <h1 className="mt-[4mm] text-[11mm] leading-tight font-bold text-balance">
            {event.title}
          </h1>

          {event.venue ? <p className="mt-[3mm] text-[4.5mm]">{event.venue}</p> : null}
        </header>

        <div className="flex w-full flex-col items-center">
          {/* A plain <img>, not next/image: an SVG from our own API behind a
              session cookie. The optimiser can neither fetch nor improve it,
              and rasterising it would defeat the point of printing a vector. */}
          <img
            src={eventQrCodeUrl(event.id)}
            alt={`QR code linking to the question page for ${event.title}`}
            className="h-[105mm] w-[105mm]"
          />

          <p className="mt-[6mm] text-[5mm] font-medium">Scan to ask a question</p>
          <p className="mt-[2mm] text-[4mm]">No app and no sign-up needed</p>
        </div>

        <footer className="w-full">
          <p className="text-[3.5mm] tracking-[0.15em] uppercase">Or go to</p>
          <p className="mt-[2mm] font-mono text-[5mm] break-all">{stripScheme(event.joinUrl)}</p>

          <p className="mt-[6mm] text-[3.5mm] tracking-[0.15em] uppercase">And enter the code</p>
          <p
            className="mt-[1mm] font-mono text-[14mm] leading-none font-bold tracking-[0.15em]"
            style={{ color: palette.accentText }}
          >
            {event.joinCode}
          </p>
        </footer>
      </main>

      <p className="mx-auto max-w-[210mm] px-5 pb-10 text-center text-xs text-[var(--muted)] print:hidden">
        Print at A4, 100% scale — “fit to page” will shrink the code. Black and white is fine; the
        code is designed to stay scannable.
      </p>
    </>
  );
}

/**
 * Drops `https://` from the printed URL.
 *
 * Nobody types a scheme into a phone browser, and the eleven characters it
 * costs are eleven that could have made the address itself bigger on a wall
 * somebody is reading from a distance.
 */
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//u, '');
}
