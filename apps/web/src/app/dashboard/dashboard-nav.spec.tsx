import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardNav } from './dashboard-nav';

/**
 * The dashboard bar.
 *
 * It exists because the way back to the event list, the way to a new event
 * and the way out were once only on the event list — unreachable from inside
 * an event. These tests pin that all three are there wherever it renders.
 */
const { signOut, replace, pathname } = vi.hoisted(() => ({
  signOut: vi.fn(),
  replace: vi.fn(),
  pathname: { current: '/dashboard/events/01930000-0000-7000-8000-0000000000e1' },
}));

vi.mock('@/lib/api-client/organizer', () => ({ signOut }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  pathname.current = '/dashboard/events/01930000-0000-7000-8000-0000000000e1';
});

describe('DashboardNav', () => {
  it('offers the way back, a new event and sign out from inside an event', () => {
    render(<DashboardNav />);

    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your events' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'New event' })).toHaveAttribute(
      'href',
      '/dashboard/events/new',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('marks the event list as the current page when on it', () => {
    pathname.current = '/dashboard';
    render(<DashboardNav />);

    expect(screen.getByRole('link', { name: 'Your events' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('does not offer "New event" on the new-event form itself', () => {
    pathname.current = '/dashboard/events/new';
    render(<DashboardNav />);

    expect(screen.queryByRole('link', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('signs out and goes to sign-in', async () => {
    signOut.mockResolvedValue(undefined);
    render(<DashboardNav />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signOut).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('still leaves when signing out fails, rather than stranding the user', async () => {
    signOut.mockRejectedValue(new Error('network'));
    render(<DashboardNav />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
  });
});
