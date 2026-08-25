import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { ATTENDEE_TOKEN_COOKIE } from '@eventq/contracts';
import {
  ATTENDEE_TOKENS,
  type AttendeeTokenClaims,
  type AttendeeTokens,
} from '../domain/attendee-tokens.port';
import { AttendeeSessionRequiredError } from '../domain/question.errors';

/**
 * Attendee authentication.
 *
 * Applied explicitly with @UseGuards rather than globally, because the global
 * AuthGuard already covers every route and these endpoints opt out of it with
 * @Public(). "Public" here means "no organizer session", not "no identity" —
 * this guard supplies the second one.
 *
 * It deliberately does NOT decide whether the token is valid for the event in
 * the URL. That check needs a database read and belongs with the other event
 * policy decisions, so it lives in the use-case. The guard answers only
 * "is this a genuine, unexpired attendee token", which needs no I/O at all —
 * the point of a stateless token when 800 people scan at once.
 */
export interface AttendeeRequest extends Request {
  attendee?: AttendeeTokenClaims;
}

@Injectable()
export class AttendeeGuard implements CanActivate {
  constructor(@Inject(ATTENDEE_TOKENS) private readonly tokens: AttendeeTokens) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<AttendeeRequest>();

    const token = readAttendeeToken(request);
    if (!token) throw new AttendeeSessionRequiredError();

    // Throws AttendeeSessionRequiredError for expired, forged and malformed
    // alike, so none of them can be told apart from the outside.
    request.attendee = await this.tokens.verify(token);

    return true;
  }
}

function readAttendeeToken(request: AttendeeRequest): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[ATTENDEE_TOKEN_COOKIE];
  if (fromCookie) return fromCookie;

  // Bearer is accepted for non-browser clients — integration tests, and later
  // any native app. Browsers always use the cookie, which is httpOnly and
  // therefore unreadable by an injected script.
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

  return undefined;
}

/** Injects the verified attendee claims into a controller parameter. */
export const AttendeeCtx = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): AttendeeTokenClaims => {
    const request = executionContext.switchToHttp().getRequest<AttendeeRequest>();
    if (!request.attendee) {
      // Only reachable if a controller forgot @UseGuards(AttendeeGuard).
      // Failing loudly beats handing a handler an undefined identity.
      throw new Error('Attendee context is missing. Is AttendeeGuard applied to this route?');
    }
    return request.attendee;
  },
);
