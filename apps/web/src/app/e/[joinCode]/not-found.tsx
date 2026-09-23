import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Event not found',
  robots: { index: false, follow: false },
};

/**
 * One page for every reason an event cannot be shown.
 *
 * The API answers 404 identically for an unknown join code, a draft, an
 * archived event and a private one, so that nobody can probe for valid codes or
 * learn that an event exists before its organizer chose to reveal it. This page
 * has to honour that: rendering a different explanation for one of those cases
 * would hand back exactly the distinction the API worked to remove, from the
 * one place an attacker is already looking.
 *
 * A closed event is no longer in that list — a public event that ran and
 * finished gets its own screen, because its join code was displayed to a whole
 * room and was never a secret. That case therefore never reaches this page, and
 * the wording below no longer has to cover it.
 *
 * What remains is deliberately vague, and phrased around what the person can
 * actually DO rather than around what went wrong.
 */
export default function EventNotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-5 py-12 text-center"
    >
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">This event is not available</h1>

      <p className="mt-4 text-base leading-relaxed text-[var(--color-muted,#666)]">
        The link may be mistyped, or the event may not have started yet. Check the code on the
        screen or ask the organizer.
      </p>
    </main>
  );
}
