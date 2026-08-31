import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api-client';
import { safeDestination, SignInForm } from './sign-in-form';

const { signIn, replace, searchParams } = vi.hoisted(() => ({
  signIn: vi.fn(),
  replace: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('@/lib/api-client/organizer', () => ({ signIn }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams.current,
}));

function problem(code: string, status: number, detail?: string) {
  return new ApiError(
    {
      type: 'about:blank',
      title: code,
      status,
      code: code as never,
      ...(detail ? { detail } : {}),
      traceId: 'trace-1',
    },
    status,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
  signIn.mockResolvedValue({ organizer: { id: 'u1' } });
});

describe('signing in', () => {
  it('sends the credentials and lands on the dashboard', async () => {
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText(/email/i), 'alice@eventq.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct-horse-battery-staple');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(signIn).toHaveBeenCalledWith({
      email: 'alice@eventq.test',
      password: 'correct-horse-battery-staple',
    });
    // replace rather than push: the back button must not return to a sign-in
    // form for a session that now exists.
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('returns someone to the page they were trying to reach', async () => {
    searchParams.current = new URLSearchParams({ next: '/dashboard/events/abc' });
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText(/email/i), 'alice@eventq.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct-horse-battery-staple');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/events/abc'));
  });

  it('says nothing about which half of the credentials was wrong', async () => {
    // Matches the API, which makes a wrong email and a wrong password
    // indistinguishable so the endpoint cannot be used to discover which
    // addresses have accounts.
    signIn.mockRejectedValue(problem('INVALID_CREDENTIALS', 401));
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText(/email/i), 'alice@eventq.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'not-the-right-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Scoped by text rather than by role: FormField renders its own empty
    // role="alert" slot for each input, so the role alone is ambiguous here.
    expect(await screen.findByText(/do not match an account/i)).toBeInTheDocument();
    // One message covering both possibilities — nothing tells the visitor which
    // half was wrong, so this form cannot be used to discover valid addresses.
    expect(screen.queryByText(/no account with that email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/incorrect password/i)).not.toBeInTheDocument();
  });

  it('lets someone try again after a failure', async () => {
    signIn.mockRejectedValueOnce(problem('INVALID_CREDENTIALS', 401));
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText(/email/i), 'alice@eventq.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'not-the-right-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByText(/do not match an account/i);
    // The button must come back out of its loading state, or a mistyped
    // password locks someone out of their own form.
    expect(screen.getByRole('button', { name: /sign in/i })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

/**
 * `next` arrives in a URL that anyone can construct and send to anyone else,
 * so it is attacker-controlled input on the page where a password is typed.
 * Following it blindly is a textbook open redirect: someone clicks a link,
 * signs in for real, and is handed to a page that looks exactly like this one.
 */
describe('the redirect guard', () => {
  it('follows a relative path into the dashboard', () => {
    expect(safeDestination('/dashboard')).toBe('/dashboard');
    expect(safeDestination('/dashboard/events/abc')).toBe('/dashboard/events/abc');
  });

  it('refuses an absolute url to another site', () => {
    expect(safeDestination('https://eventq-login.example/steal')).toBe('/dashboard');
  });

  it('refuses a protocol-relative url, which a browser treats as absolute', () => {
    // The case that gets missed: `//evil.example` starts with a slash and
    // passes a naive "is it relative" check, then loads a different origin.
    expect(safeDestination('//evil.example')).toBe('/dashboard');
  });

  it('refuses a javascript url', () => {
    expect(safeDestination('javascript:alert(1)')).toBe('/dashboard');
  });

  it('refuses a relative path outside the dashboard', () => {
    expect(safeDestination('/e/H4K2M9PQ')).toBe('/dashboard');
  });

  it('falls back to the dashboard when nothing was asked for', () => {
    expect(safeDestination(null)).toBe('/dashboard');
    expect(safeDestination('')).toBe('/dashboard');
  });
});
