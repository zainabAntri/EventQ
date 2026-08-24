import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { env } from '@/lib/env';
import './globals.css';

// Self-hosted by next/font: no render-blocking request to a third party, no
// layout shift when the face swaps in, and no external origin in the CSP.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: {
    default: 'EventQ - Audience Q&A for live events',
    template: '%s | EventQ',
  },
  description:
    'Collect, moderate and rank audience questions in real time. Attendees scan a QR code and ask - no app, no account.',
  openGraph: {
    type: 'website',
    siteName: 'EventQ',
    url: env.NEXT_PUBLIC_SITE_URL,
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
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
