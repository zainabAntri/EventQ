import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedOrganizer, RegisterRequest } from '@eventq/contracts';
import { PASSWORD_HASHER, type PasswordHasher } from '../domain/password-hasher.port';
import { ORGANIZER_REPOSITORY, type OrganizerRepository } from '../domain/organizer.repository';
import { EmailAlreadyRegisteredError } from '../domain/auth.errors';
import { toAuthenticatedOrganizer } from './organizer.mapper';

/**
 * Registers an organizer and their organization.
 *
 * Both are created together, because every event belongs to an organization and
 * an organizer without one cannot do anything. Splitting the steps would only
 * create a state where a signed-in user has nowhere to put an event.
 */
@Injectable()
export class RegisterOrganizerUseCase {
  constructor(
    @Inject(ORGANIZER_REPOSITORY) private readonly organizers: OrganizerRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(request: RegisterRequest): Promise<AuthenticatedOrganizer> {
    // Hashed BEFORE the uniqueness check, so a taken email and a free one take
    // comparable time. Returning early on a known email would make registration
    // a timing oracle for which addresses exist.
    const passwordHash = await this.hasher.hash(request.password);

    if (await this.organizers.emailExists(request.email)) {
      throw new EmailAlreadyRegisteredError();
    }

    try {
      const organizer = await this.organizers.createWithOrganization({
        email: request.email,
        name: request.name,
        passwordHash,
        organizationName: request.organizationName ?? `${request.name}'s organization`,
      });

      return toAuthenticatedOrganizer(organizer);
    } catch (error) {
      // Two simultaneous registrations both pass the check above; the unique
      // index is what actually decides. Translating it here means the loser
      // gets a clean 409 rather than a 500.
      if (isUniqueConstraintViolation(error, 'email')) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }
}

function isUniqueConstraintViolation(error: unknown, field: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;

  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  return true;
}
