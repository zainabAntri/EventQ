import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_THRESHOLD,
  MAX_LOCKOUT_SECONDS,
  isLockedOut,
  lockoutSecondsFor,
  registerFailure,
  resetLockout,
  secondsUntilUnlock,
} from './account-lockout';

/**
 * Pure domain logic, so the escalation curve is testable without a database,
 * a clock or a framework.
 */
describe('account lockout', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');

  it('tolerates honest mistakes before imposing any delay', () => {
    // People mistype passwords. Locking on the second attempt is a support
    // burden, not a security win.
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      expect(lockoutSecondsFor(attempt)).toBe(0);
    }
  });

  it('escalates exponentially once the threshold is passed', () => {
    expect(lockoutSecondsFor(6)).toBe(30);
    expect(lockoutSecondsFor(7)).toBe(60);
    expect(lockoutSecondsFor(8)).toBe(120);
    expect(lockoutSecondsFor(9)).toBe(240);
  });

  it('caps the delay so an account is never permanently unusable', () => {
    // Without a cap, an attacker could lock a victim out indefinitely by
    // failing on purpose - denial of service dressed up as a security control.
    expect(lockoutSecondsFor(50)).toBe(MAX_LOCKOUT_SECONDS);
    expect(lockoutSecondsFor(500)).toBe(MAX_LOCKOUT_SECONDS);
  });

  it('locks the account after the threshold is crossed', () => {
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) state = registerFailure(state, now);

    expect(isLockedOut(state, now)).toBe(false);

    state = registerFailure(state, now);
    expect(isLockedOut(state, now)).toBe(true);
    expect(secondsUntilUnlock(state, now)).toBe(30);
  });

  it('unlocks once the window has passed', () => {
    const state = { failedLoginCount: 6, lockedUntil: new Date(now.getTime() + 30_000) };

    expect(isLockedOut(state, now)).toBe(true);
    expect(isLockedOut(state, new Date(now.getTime() + 31_000))).toBe(false);
  });

  it('clears the counter completely on a successful sign-in', () => {
    // Otherwise a user who fails four times over a month is one mistake away
    // from a lockout forever.
    expect(resetLockout()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });

  it('treats an unlocked account as having no wait', () => {
    expect(secondsUntilUnlock({ failedLoginCount: 0, lockedUntil: null }, now)).toBe(0);
  });
});
