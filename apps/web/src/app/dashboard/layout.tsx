import { DashboardNav } from './dashboard-nav';

/**
 * Shared frame for every organizer page: the navigation bar, then the page.
 *
 * A Server Component; only the bar itself is a client leaf, because signing
 * out needs a click handler and the router.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DashboardNav />
      {children}
    </>
  );
}
