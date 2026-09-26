'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui';
import { cn } from '@/lib/cn';
import { signOut } from '@/lib/api-client/organizer';

/**
 * The bar across the top of every dashboard page.
 *
 * It lives in the dashboard layout rather than on any one page because the
 * three things in it — back to the events, start a new one, sign out — are
 * needed from everywhere. When they sat only on the event list, a moderator
 * who opened an event had no way back out of it, and no way to sign out,
 * short of editing the URL.
 *
 * Hidden when printing, so the poster page prints as the poster alone.
 */
export function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const onEventList = pathname === '/dashboard';
  const onNewEvent = pathname === '/dashboard/events/new';

  return (
    <header className="border-b border-[var(--border)] print:hidden">
      <nav
        aria-label="Dashboard"
        className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5"
      >
        <Link
          href="/dashboard"
          aria-current={onEventList ? 'page' : undefined}
          className={cn(
            'rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-current/5',
            onEventList && 'text-brand-600 dark:text-brand-300',
          )}
        >
          <span aria-hidden="true">EventQ · </span>Your events
        </Link>

        <div className="flex items-center gap-2">
          {onNewEvent ? null : (
            <Link
              href="/dashboard/events/new"
              className={buttonVariants({ size: 'sm', variant: 'primary' })}
            >
              New event
            </Link>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Navigate regardless of the outcome: the API clears the cookies
              // even for an already-expired session, and a failure here must not
              // leave someone stuck on a page they meant to leave. `.catch` rather
              // than `.finally`: finally re-throws, which navigated but also left
              // an unhandled rejection behind whenever the request failed.
              void signOut()
                .catch(() => undefined)
                .then(() => router.replace('/sign-in'));
            }}
          >
            Sign out
          </Button>
        </div>
      </nav>
    </header>
  );
}
