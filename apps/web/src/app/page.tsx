import type { Metadata } from 'next';
import Link from 'next/link';
import { env } from '@/lib/env';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from '@/lib/site';

/**
 * The only indexable page. The root layout defaults every page to noindex, so
 * this opts back in. `openGraph` is repeated in full because Next replaces the
 * layout's object rather than merging into it.
 */
export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: 'en_US',
    url: '/',
  },
  robots: { index: true, follow: true },
};

/**
 * Describes EventQ to search engines: what the site is and who publishes it.
 * Static and ours, so embedding it is safe. `<` is still escaped, so a future
 * edit cannot close the script tag by accident.
 */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: SITE_NAME,
      url: env.NEXT_PUBLIC_SITE_URL,
      description: SITE_DESCRIPTION,
    },
    {
      '@type': 'WebApplication',
      name: SITE_NAME,
      url: env.NEXT_PUBLIC_SITE_URL,
      description: SITE_DESCRIPTION,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Any (web browser)',
    },
  ],
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
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />

      <main
        id="main"
        className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16"
      >
        <p className="text-sm font-medium tracking-wide text-brand-600 uppercase">EventQ</p>

        <h1 className="mt-3 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Every question from the room, organised.
        </h1>

        <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--color-muted,#666)]">
          Attendees scan a QR code and ask — no app, no account. You moderate, rank and answer in
          real time.
        </p>

        <section aria-labelledby="features-heading" className="mt-12">
          <h2 id="features-heading" className="sr-only">
            Features
          </h2>
          <dl className="grid gap-6 sm:grid-cols-3">
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
        </section>

        <p className="mt-12 text-sm text-[var(--color-muted,#666)]">
          Attendees can ask, and organizers can moderate.{' '}
          <Link className="underline underline-offset-2" href="/sign-in">
            Sign in
          </Link>{' '}
          to open your dashboard.
        </p>
      </main>
    </>
  );
}
