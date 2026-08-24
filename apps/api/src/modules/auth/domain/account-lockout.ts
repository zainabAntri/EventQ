/**
 * Progressive account lockout.
 *
 * Rate limiting by IP alone does not stop credential stuffing: an attacker with
 * a botnet has effectively unlimited IPs but still has to guess one account's
 * password. Per-account backoff is what makes that expensive.
 *
 * Pure functions over pure data — no clock, no database, no framework — so the
 * escalation curve is trivially testable.
 */

/** Failures tolerated before any delay is imposed. */
export const LOCKOUT_THRESHOLD = 5;

/** Ceiling on the backoff, so an account is never permanently unusable. */
export const MAX_LOCKOUT_SECONDS = 15 * 60;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

/**
 * Seconds to lock after `failedCount` consecutive failures.
 *
 * Doubles from 30s once the threshold is passed, capped at 15 minutes:
 *   5 -> 0s, 6 -> 30s, 7 -> 60s, 8 -> 120s ... capped
 */
export function lockoutSecondsFor(failedCount: number): number {
  if (failedCount <= LOCKOUT_THRESHOLD) return 0;

  const step = failedCount - LOCKOUT_THRESHOLD - 1;
  const seconds = 30 * 2 ** step;
  return Math.min(seconds, MAX_LOCKOUT_SECONDS);
}

export function isLockedOut(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function secondsUntilUnlock(state: LockoutState, now: Date): number {
  if (!isLockedOut(state, now)) return 0;
  const remaining = (state.lockedUntil as Date).getTime() - now.getTime();
  return Math.max(1, Math.ceil(remaining / 1000));
}

/** Next lockout state after a failed attempt. */
export function registerFailure(state: LockoutState, now: Date): LockoutState {
  const failedLoginCount = state.failedLoginCount + 1;
  const seconds = lockoutSecondsFor(failedLoginCount);

  return {
    failedLoginCount,
    lockedUntil: seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null,
  };
}

/** A successful login clears the counter entirely. */
export function resetLockout(): LockoutState {
  return { failedLoginCount: 0, lockedUntil: null };
}
