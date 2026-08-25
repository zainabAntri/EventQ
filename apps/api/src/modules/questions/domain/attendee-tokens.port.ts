/**
 * Port: attendee identity tokens.
 *
 * An attendee token is NOT a login. It is a pseudonymous, device-scoped and
 * EVENT-scoped identity minted on first scan, with no account, no password and
 * no personal data required.
 *
 * The `eventId` claim is the security-critical part. It binds a token to one
 * event, which is what makes the Attendee model's promise real: the same person
 * at two events is two unlinkable rows, so there is no cross-event tracking to
 * leak and per-event PII purging stays a clean delete.
 *
 * What the identity actually buys, given it proves nothing about who someone is:
 * rate limiting per person rather than per IP (a conference shares one NAT
 * address, so per-IP alone would throttle a whole room), one vote per person,
 * and the ability to show someone their own pending question.
 */

export interface AttendeeTokenClaims {
  /** Attendee row id. */
  sub: string;
  /** The event this token is valid for, and ONLY this event. */
  eventId: string;
}

export interface AttendeeTokens {
  issue(claims: AttendeeTokenClaims): Promise<string>;

  /**
   * Verifies a token and returns its claims.
   *
   * Must throw for a missing, malformed, expired or tampered token. Callers are
   * responsible for checking the eventId matches the event being acted on — the
   * token proving valid is not the same as it being valid HERE.
   */
  verify(token: string): Promise<AttendeeTokenClaims>;
}

export const ATTENDEE_TOKENS = Symbol('ATTENDEE_TOKENS');
