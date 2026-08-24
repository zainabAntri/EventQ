import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedOrganizer, LoginRequest } from '@eventq/contracts';
import { PASSWORD_HASHER, type PasswordHasher } from '../domain/password-hasher.port';
import { ORGANIZER_REPOSITORY, type OrganizerRepository } from '../domain/organizer.repository';
import { AccountLockedError, InvalidCredentialsError } from '../domain/auth.errors';
import { isLockedOut, registerFailure, secondsUntilUnlock } from '../domain/account-lockout';
import { toAuthenticatedOrganizer } from './organizer.mapper';

/**
 * Verifies credentials.
 *
 * Two properties matter as much as correctness:
 *
 *   1. A wrong email and a wrong password are indistinguishable — same code,
 *      same message, comparable timing. Otherwise login becomes a way to
 *      enumerate which accounts exist.
 *   2. Failures escalate per account, so an attacker with many IPs still has to
 *      wait. IP rate limiting alone does not stop credential stuffing.
 */
@Injectable()
export class LoginOrganizerUseCase {
  constructor(
    @Inject(ORGANIZER_REPOSITORY) private readonly organizers: OrganizerRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(request: LoginRequest): Promise<AuthenticatedOrganizer> {
    const now = new Date();
    const organizer = await this.organizers.findByEmail(request.email);

    if (!organizer || organizer.deletedAt !== null) {
      // Still does the work a real account would, so response time does not
      // reveal whether the email is registered.
      await this.hasher.verify(DUMMY_HASH, request.password);
      throw new InvalidCredentialsError();
    }

    if (isLockedOut(organizer, now)) {
      throw new AccountLockedError(secondsUntilUnlock(organizer, now));
    }

    const passwordValid = await this.hasher.verify(organizer.passwordHash, request.password);

    if (!passwordValid) {
      const next = registerFailure(organizer, now);
      await this.organizers.applyLockout(organizer.id, next);

      // If that failure crossed the threshold, say so now rather than letting
      // the next attempt fail confusingly.
      if (next.lockedUntil && next.lockedUntil > now) {
        throw new AccountLockedError(secondsUntilUnlock(next, now));
      }
      throw new InvalidCredentialsError();
    }

    // An account with no organization cannot act. Reported as invalid
    // credentials rather than a distinct error, to keep the response uniform.
    if (!organizer.membership) throw new InvalidCredentialsError();

    // Transparent rehash when the hashing parameters have been re-tuned since
    // this password was set. The user notices nothing.
    const rehashed = this.hasher.needsRehash(organizer.passwordHash)
      ? await this.hasher.hash(request.password)
      : undefined;

    await this.organizers.recordSuccessfulLogin(organizer.id, rehashed);

    return toAuthenticatedOrganizer(organizer);
  }
}

/**
 * A real argon2id hash of an unrelated value, used only to burn comparable CPU
 * time when the email does not exist.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEyMw$Vt3Qw8xJ2mKZ5nGx1pQ7yR4tW9sL0aB6cD8eF2gH3iI';
