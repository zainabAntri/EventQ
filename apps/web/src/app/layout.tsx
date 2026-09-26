import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { env } from '@/lib/env';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from '@/lib/site';
import './globals.css';

// Self-hosted by next/font: no render-blocking request to a third party, no
// layout shift when the face swaps in, and no external origin in the CSP.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * Defaults for every page. The favicon, Apple touch icon and share image come
 * from the icon.svg, apple-icon.tsx and opengraph-image.tsx files next to this
 * one.
 *
 * `robots` defaults to noindex, so a page nobody thought about stays private.
 * Only the landing page opts in. This matches the X-Robots-Tag header in
 * next.config.ts.
 *
 * The share card is the same generic EventQ card on every page. An event link
 * posted in a group chat must not preview the event's title or description,
 * because a private event's details would then travel with the link.
 */
export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  applicationName: SITE_NAME,
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111318' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        {/* Attendees on phones and moderators on keyboards both need this. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
