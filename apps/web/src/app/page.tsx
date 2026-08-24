import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'EventQ - Audience Q&A for live events',
  alternates: { canonical: '/' },
};

/**
 * Marketing landing page.
 *
 * A Server Component with no client JavaScript at all — this is the page that
 * carries Core Web Vitals and SEO, so every kilobyte of hydration we avoid here
 * is a direct LCP and INP win.
 */
export default function HomePage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-brand-600 uppercase">EventQ</p>

      <h1 className="mt-3 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
        Every question from the room, organised.
      </h1>

      <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--color-muted,#666)]">
        Attendees scan a QR code and ask — no app, no account. You moderate, rank and answer in real
        time.
      </p>

      <dl className="mt-12 grid gap-6 sm:grid-cols-3">
        {[
          { term: 'No signup', desc: 'Attendees scan and ask in seconds.' },
          { term: 'Moderated', desc: 'Approve before the room sees it.' },
          { term: 'Ranked', desc: 'The best questions rise to the top.' },
        ].map(({ term, desc }) => (
          <div key={term} className="rounded-lg border border-[var(--border,#e5e7eb)] p-5">
            <dt className="font-semibold">{term}</dt>
            <dd className="mt-1.5 text-sm text-[var(--color-muted,#666)]">{desc}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-12 text-sm text-[var(--color-muted,#666)]">
        Phase 0 foundation. The organizer dashboard and attendee flow arrive in Phase 1.
      </p>
    </main>
  );
}
