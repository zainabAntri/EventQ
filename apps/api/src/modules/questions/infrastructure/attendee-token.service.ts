import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { parseDurationSeconds } from '../../../shared/time/duration';
import { AttendeeSessionRequiredError } from '../domain/question.errors';
import type { AttendeeTokenClaims, AttendeeTokens } from '../domain/attendee-tokens.port';

/**
 * Attendee tokens.
 *
 * A short-lived, stateless JWT — unlike the organizer's refresh token, which is
 * an opaque value stored as a hash. The difference is justified by what each is
 * worth: an organizer session grants access to an organization's data and must
 * be revocable the instant it is suspected stolen, whereas an attendee token
 * grants only the ability to ask a question at ONE event, for a few hours,
 * under an identity that contains no personal data.
 *
 * Statelessness buys the thing that actually matters here: 800 people scanning
 * the same QR code within 90 seconds cost zero database reads to authenticate.
 *
 * Revocation still exists where it needs to — blocking an attendee is a flag on
 * their row, checked on every submission, so a moderator's decision takes
 * effect immediately regardless of any token they hold.
 *
 * Signed with ATTENDEE_TOKEN_SECRET, which env.schema.ts refuses to boot with
 * if it matches JWT_ACCESS_SECRET. That check is what stops a forged attendee
 * token from ever being accepted as an organizer session.
 */
@Injectable()
export class AttendeeTokenService implements AttendeeTokens {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  issue(claims: AttendeeTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.config.auth.attendeeSecret,
      // Seconds rather than the raw "12h" string: jsonwebtoken types the string
      // form as a template literal that a plain string does not satisfy.
      expiresIn: parseDurationSeconds(this.config.auth.attendeeTtl),
    });
  }

  async verify(token: string): Promise<AttendeeTokenClaims> {
    try {
      const claims = await this.jwt.verifyAsync<AttendeeTokenClaims>(token, {
        secret: this.config.auth.attendeeSecret,
      });

      // A token signed with the right key but missing its claims is not usable.
      // Checked rather than trusted, because verifyAsync only proves the
      // signature, not the shape.
      if (!claims?.sub || !claims?.eventId) throw new Error('Malformed attendee token');

      return { sub: claims.sub, eventId: claims.eventId };
    } catch {
      // Expired, forged, malformed and absent all collapse into one error. A
      // distinct message per cause would let someone probe the token format on
      // an endpoint that has no account behind it.
      throw new AttendeeSessionRequiredError();
    }
  }
}
