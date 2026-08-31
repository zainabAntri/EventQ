import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

/**
 * Organizer sign-in.
 *
 * The API has had authentication since Phase 2, but nothing in the browser
 * called it — the dashboard is the first screen that needs a signed-in
 * organizer, so this is where a login form finally earns its place.
 *
 * The Suspense boundary is required rather than decorative: the form reads the
 * query string to find where the visitor was heading, and Next needs a boundary
 * around any component that does.
 */
export default function SignInPage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-12">
      <p className="text-sm font-medium tracking-wide text-brand-600 uppercase">EventQ</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Sign in</h1>

      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </main>
  );
}
