import type { CookieOptions, Response } from 'express';
import { ATTENDEE_TOKEN_COOKIE, attendeeCookiePath } from '@eventq/contracts';
import type { AppConfigService } from '../../../shared/config/app-config.service';
import { parseDurationMs } from '../../../shared/time/duration';

/**
 * The attendee cookie.
 *
 * httpOnly, so an injected script cannot read the token and replay someone
 * else's identity — the same reasoning as the organizer session cookies, and
 * the reason the token is not returned in the response body.
 *
 * The interesting decision is the PATH. It is scoped to one event's routes
 * rather than to `/`:
 *
 *   /api/v1/public/events/H4K2N9PQ
 *
 * That is what lets one device hold separate identities at two concurrent
 * events without them colliding — a single `/`-scoped cookie would be
 * overwritten by whichever event was scanned most recently, silently detaching
 * someone from the first one. It also means a request to one event never
 * carries another event's token, so the two identities are unlinkable in
 * transit as well as in the database.
 *
 * Path is NOT a security boundary in browsers, and nothing here relies on it
 * being one — the token's own `eventId` claim is what authorises anything, and
 * it is checked server-side on every request.
 */
function baseOptions(config: AppConfigService): CookieOptions {
  const { domain, secure } = config.cookies;
  return {
    httpOnly: true,
    secure,
    // Lax, matching the organizer cookies: the web app and the API are sibling
    // subdomains of one registrable domain, so they are same-site and the
    // cookie travels on XHR without any third-party-cookie policy applying.
    sameSite: 'lax',
    ...(domain ? { domain } : {}),
  };
}

export function setAttendeeCookie(
  response: Response,
  config: AppConfigService,
  joinCode: string,
  token: string,
): void {
  response.cookie(ATTENDEE_TOKEN_COOKIE, token, {
    ...baseOptions(config),
    path: attendeeCookiePath(joinCode),
    maxAge: parseDurationMs(config.auth.attendeeTtl),
  });
}

// There is deliberately no clearAttendeeCookie here. Nothing in the product
// "signs out" of an event — the identity is pseudonymous, carries no personal
// data and expires on its own. Writing one before a feature needs it would be a
// function nobody calls and nobody tests, which is exactly how a subtly wrong
// helper survives until the day something finally uses it.
