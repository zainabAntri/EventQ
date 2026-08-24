/**
 * Port: session token lifecycle.
 *
 * The domain states that a session can be issued, rotated, revoked and
 * verified. Whether that is a JWT plus a hashed opaque token in Postgres, or
 * something else entirely, is an infrastructure decision.
 */

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Organization the session acts within. */
  org: string;
  role: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface SessionContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface SessionTokens {
  issue(claims: AccessTokenClaims, context: SessionContext): Promise<IssuedTokens>;

  /** Exchanges a refresh token for a new pair. Must revoke the whole family and
   *  throw if the presented token was already rotated. */
  rotate(
    presentedToken: string,
    context: SessionContext,
  ): Promise<{ tokens: IssuedTokens; claims: AccessTokenClaims }>;

  revoke(presentedToken: string): Promise<void>;

  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export const SESSION_TOKENS = Symbol('SESSION_TOKENS');
