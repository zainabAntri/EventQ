'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MIN_PASSWORD_LENGTH } from '@eventq/contracts';
import { Alert, Button, FormField, Input, Label } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { signIn } from '@/lib/api-client/organizer';

/**
 * Sign-in form.
 *
 * Everything validated here is validated again on the server. This exists to
 * make an obvious mistake instant rather than a round trip; it is not a
 * security control and nothing depends on it being one.
 */
export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (submitted: React.FormEvent): Promise<void> => {
    submitted.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await signIn({ email, password });
      // replace, not push: the back button must not return to a sign-in form
      // for a session that now exists.
      router.replace(safeDestination(searchParams.get('next')));
    } catch (caught) {
      setError(messageFor(caught));
      setIsSubmitting(false);
    }
  };

  return (
    <form className="mt-8 space-y-5" onSubmit={(submitted) => void handleSubmit(submitted)}>
      {error ? (
        <Alert severity="error" title="Could not sign you in">
          {error}
        </Alert>
      ) : null}

      <FormField>
        {/* No htmlFor and no id: FormField generates both and wires them
            together, so a label can never drift from its control. */}
        <Label>Email</Label>
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(changed) => setEmail(changed.target.value)}
        />
      </FormField>

      <FormField>
        <Label>Password</Label>
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(changed) => setPassword(changed.target.value)}
        />
      </FormField>

      <Button type="submit" fullWidth isLoading={isSubmitting} loadingLabel="Signing in">
        Sign in
      </Button>
    </form>
  );
}

/**
 * Where to go after signing in.
 *
 * The `next` parameter is attacker-controllable — it arrives in a URL anyone
 * can construct and send — so it is not followed unless it is a relative path
 * into the dashboard. Without that check this is a textbook open redirect:
 * `/sign-in?next=https://eventq-login.example` would send someone who just
 * typed their password to a page that looks exactly like this one.
 *
 * The `//` case matters as much as the scheme: `//evil.example` is
 * protocol-relative and a browser treats it as absolute.
 */
export function safeDestination(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/') || next.startsWith('//')) return '/dashboard';
  if (!next.startsWith('/dashboard')) return '/dashboard';

  return next;
}

/**
 * Branches on the machine-readable code, never on the wording.
 *
 * The credentials case is deliberately vague, matching the API: a wrong email
 * and a wrong password are indistinguishable, so this endpoint cannot be used
 * to find out which addresses have accounts.
 */
function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return 'We could not reach EventQ. Check your connection and try again.';
  }

  switch (caught.code) {
    case 'INVALID_CREDENTIALS':
      return 'That email and password do not match an account.';
    case 'ACCOUNT_LOCKED':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'RATE_LIMITED':
      return 'Too many attempts from this network. Please wait and try again.';
    case 'VALIDATION_FAILED':
      return 'Please check your email and password and try again.';
    default:
      return 'Something went wrong signing you in. Please try again.';
  }
}
