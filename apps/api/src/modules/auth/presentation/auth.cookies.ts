import type { CookieOptions, Response } from 'express';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@eventq/contracts';
import type { AppConfigService } from '../../../shared/config/app-config.service';
import { parseDurationMs } from '../../../shared/time/duration';

/**
 * Session cookie handling.
 *
 * Tokens live in httpOnly cookies rather than a response body, so no JavaScript
 * — including an injected XSS payload — can read them.
 *
 * SameSite=Lax works across the Vercel/AWS split ONLY because the web app and
 * the API are sibling subdomains of one registrable domain
 * (app.eventq.io / api.eventq.io). Same site, different origin: cookies flow on
 * XHR, and no third-party-cookie policy applies. On different apex domains this
 * silently fails and every authenticated request 401s.
 */

/** The refresh cookie is scoped to the refresh route, so it is not sent on
 *  ordinary API calls. Less exposure per request, and a smaller blast radius if
 *  one request is ever logged with its headers. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(config: AppConfigService): CookieOptions {
  const { domain, secure } = config.cookies;
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    ...(domain ? { domain } : {}),
  };
}

export function setSessionCookies(
  response: Response,
  config: AppConfigService,
  tokens: { accessToken: string; refreshToken: string; refreshExpiresAt: Date },
): void {
  response.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...baseOptions(config),
    path: '/',
    maxAge: parseDurationMs(config.auth.accessTtl),
  });

  response.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...baseOptions(config),
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  });
}

export function clearSessionCookies(response: Response, config: AppConfigService): void {
  // Options must match those used when setting, or the browser keeps the
  // original cookie and "sign out" silently does nothing.
  response.clearCookie(ACCESS_TOKEN_COOKIE, { ...baseOptions(config), path: '/' });
  response.clearCookie(REFRESH_TOKEN_COOKIE, {
    ...baseOptions(config),
    path: REFRESH_COOKIE_PATH,
  });
}
