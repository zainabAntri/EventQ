import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Event not found',
  robots: { index: false, follow: false },
};

/**
 * One page for every reason an event cannot be shown.
 *
 * The API deliberately answers 404 identically for an unknown join code, a
 * draft, a closed event, an archived one and a private one — so that nobody can
 * probe for valid codes or learn that an event exists before its organizer
 * chose to reveal it.
 *
 * This page has to honour that. Rendering "this event has finished" for one case
 * and "no such event" for another would hand back exactly the distinction the
 * API worked to remove, from the one place an attacker is already looking.
 *
 * The wording is therefore vague on purpose, and phrased around what the person
 * can actually DO rather than around what went wrong.
 */
export default function EventNotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-5 py-12 text-center"
    >
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">This event is not available</h1>

      <p className="mt-4 text-base leading-relaxed text-[var(--color-muted,#666)]">
        The link may be mistyped, or the event may not have started yet or may have finished. Check
        the code on the screen or ask the organizer.
      </p>
    </main>
  );
}
