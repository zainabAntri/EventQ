import {
  ConflictError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../../shared/errors/domain-error';

/**
 * Authentication failures.
 *
 * Note what is deliberately absent: there is no "no such account" error. A
 * wrong email and a wrong password both produce InvalidCredentialsError with
 * identical wording, because distinguishing them turns the login endpoint into
 * an account-enumeration oracle.
 */

export class InvalidCredentialsError extends UnauthenticatedError {
  override readonly code = 'INVALID_CREDENTIALS' as const;

  constructor() {
    // Identical message whether the email is unknown or the password is wrong.
    super('Email or password is incorrect.');
  }
}

export class EmailAlreadyRegisteredError extends ConflictError {
  override readonly code = 'EMAIL_ALREADY_REGISTERED' as const;

  constructor() {
    super('An account with that email already exists.');
  }
}

export class AccountLockedError extends RateLimitedError {
  override readonly code = 'ACCOUNT_LOCKED' as const;

  constructor(retryAfterSeconds: number) {
    super('Too many failed sign-in attempts. Try again shortly.', retryAfterSeconds);
  }
}

export class SessionExpiredError extends UnauthenticatedError {
  override readonly code = 'TOKEN_EXPIRED' as const;

  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message);
  }
}

/**
 * Raised when a refresh token that was already rotated is presented again.
 *
 * This means the token was captured: either the legitimate client replayed it,
 * or an attacker stole it. We cannot tell which, so the whole family is revoked
 * and everyone signs in again. That converts a stolen refresh token from
 * persistent access into a single-use event.
 */
export class TokenReuseDetectedError extends UnauthenticatedError {
  override readonly code = 'TOKEN_REUSE_DETECTED' as const;

  constructor() {
    super('This session is no longer valid. Please sign in again.');
  }
}
