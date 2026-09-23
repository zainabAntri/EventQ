'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { EventResponse } from '@eventq/contracts';
import { Button, LiveRegion, buttonVariants } from '@/components/ui';
import { eventQrCodeUrl } from '@/lib/api-client/organizer';

/**
 * The QR code, and the three things an organizer actually does with it.
 *
 * Display it on a screen, download it to drop into a deck or send to a printer,
 * or open the print sheet and put it on a wall. Copying the link matters more
 * than it looks: not every venue lets you put up a poster, and "read this URL
 * out" is a real fallback when the projector is already showing slides.
 *
 * ## Why the image is an <img> and not a fetch
 *
 * The endpoint returns an image, and the browser is better at loading, caching
 * and rendering one than this component would be. A same-site `<img src>`
 * carries the session cookie, so nothing here touches the bytes.
 *
 * ## The draft case
 *
 * A code for an unpublished event points at a URL that answers 404, so it is
 * shown deliberately faded with the reason stated. Hiding it entirely would be
 * worse: organizers reasonably want to print posters the day before, and the
 * code does not change when the event is published.
 */
export function QrCodeCard({ event }: { event: EventResponse }) {
  const [copied, setCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A "Copied" message that outlives the component would set state on an
  // unmounted tree; clearing on unmount is what stops that.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const isDraft = event.status === 'DRAFT';
  const isClosed = event.status === 'CLOSED' || event.status === 'ARCHIVED';

  async function copyJoinUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(event.joinUrl);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 4_000);
    } catch {
      // Clipboard access is refused in some browsers and over plain HTTP. The
      // URL is on screen and selectable either way, so this is not an error
      // worth interrupting anyone over.
      setCopied(false);
    }
  }

  return (
    <section
      aria-labelledby="qr-heading"
      className="rounded-lg border border-[var(--border)] p-4 sm:p-5"
    >
      <h2 id="qr-heading" className="text-sm font-semibold">
        Attendee link
      </h2>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="shrink-0">
          {imageFailed ? (
            <div className="flex size-40 items-center justify-center rounded-md border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--muted)]">
              The QR code could not be loaded.
            </div>
          ) : (
            <img
              src={eventQrCodeUrl(event.id)}
              alt={`QR code linking to the page for ${event.title}`}
              width={160}
              height={160}
              className={`size-40 rounded-md bg-white p-2 ${isDraft ? 'opacity-50' : ''}`}
              onError={() => setImageFailed(true)}
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[var(--muted)]">Join code</p>
          <p className="font-mono text-2xl font-semibold tracking-widest">{event.joinCode}</p>

          <p className="mt-3 text-xs font-medium text-[var(--muted)]">Link</p>
          {/* break-all, not truncate: someone reading this aloud or copying it
              by hand needs the whole URL, and an ellipsis would hide the part
              that differs between events. */}
          <p className="font-mono text-xs break-all">{event.joinUrl}</p>

          {isDraft ? (
            <p className="mt-3 text-xs text-[var(--muted)]">
              This link will not work until the event is published. The code does not change when
              you publish, so it is safe to print now.
            </p>
          ) : null}

          {isClosed ? (
            <p className="mt-3 text-xs text-[var(--muted)]">
              The event has finished. Anyone scanning now sees the questions that were asked.
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyJoinUrl()}>
              Copy link
            </Button>

            {/* Real links styled as buttons, not buttons that fake a download:
                the browser handles the save, middle-click and "open in new tab"
                work, and a keyboard user gets link semantics rather than a
                mystery control. `download` is a hint; the API's
                Content-Disposition is what actually names the file. */}
            <a
              href={eventQrCodeUrl(event.id, { format: 'svg', download: true })}
              download
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              Download SVG
            </a>

            <a
              href={eventQrCodeUrl(event.id, { format: 'png', download: true })}
              download
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              Download PNG
            </a>

            <Link
              href={`/dashboard/events/${event.id}/print`}
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              Printable poster
            </Link>
          </div>

          <p className="mt-2 text-xs text-[var(--muted)]">
            SVG stays sharp at any size — use it for posters. PNG is for slides and tools that
            refuse SVG.
          </p>
        </div>
      </div>

      {/* Announced politely, so a screen-reader user learns the copy worked
          without focus moving anywhere. */}
      <LiveRegion message={copied ? 'Attendee link copied to the clipboard.' : ''} />
    </section>
  );
}
