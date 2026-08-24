import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedOrganizer } from '@eventq/contracts';
import { UnauthenticatedError } from '../../../shared/errors/domain-error';
import { ORGANIZER_REPOSITORY, type OrganizerRepository } from '../domain/organizer.repository';
import {
  SESSION_TOKENS,
  type IssuedTokens,
  type SessionContext,
  type SessionTokens,
} from '../domain/session-tokens.port';
import { toAuthenticatedOrganizer } from './organizer.mapper';

/** Issues a session for an organizer who has just proven their identity. */
@Injectable()
export class StartSessionUseCase {
  constructor(@Inject(SESSION_TOKENS) private readonly tokens: SessionTokens) {}

  execute(organizer: AuthenticatedOrganizer, context: SessionContext): Promise<IssuedTokens> {
    return this.tokens.issue(
      {
        sub: organizer.id,
        org: organizer.organization.id,
        role: organizer.organization.role,
      },
      context,
    );
  }
}

/**
 * Rotates a session.
 *
 * The organizer is re-read from the database rather than trusted from the old
 * token: a session can outlive the authority it represents (removed from the
 * organization, account deleted), and refresh is exactly where that must be
 * noticed.
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    @Inject(SESSION_TOKENS) private readonly tokens: SessionTokens,
    @Inject(ORGANIZER_REPOSITORY) private readonly organizers: OrganizerRepository,
  ) {}

  async execute(
    presentedToken: string,
    context: SessionContext,
  ): Promise<{ tokens: IssuedTokens; organizer: AuthenticatedOrganizer }> {
    const { tokens, claims } = await this.tokens.rotate(presentedToken, context);
    const organizer = await this.loadOrganizer(claims.sub, claims.org);

    return { tokens, organizer };
  }

  private async loadOrganizer(userId: string, orgId: string): Promise<AuthenticatedOrganizer> {
    const record = await this.organizers.findByIdInOrganization(userId, orgId);
    if (!record || record.deletedAt !== null || !record.membership) {
      throw new UnauthenticatedError('This session is no longer valid.');
    }
    return toAuthenticatedOrganizer(record);
  }
}

/** Signs out. Idempotent: revoking an already-invalid token is not an error. */
@Injectable()
export class SignOutUseCase {
  constructor(@Inject(SESSION_TOKENS) private readonly tokens: SessionTokens) {}

  async execute(presentedToken: string | undefined): Promise<void> {
    if (presentedToken) await this.tokens.revoke(presentedToken);
  }
}

/**
 * Resolves the caller behind a valid access token.
 *
 * Re-reads the membership rather than trusting the token's claims, so an
 * organizer removed from their organization stops being able to act
 * immediately rather than when their access token happens to expire.
 */
@Injectable()
export class GetCurrentOrganizerUseCase {
  constructor(@Inject(ORGANIZER_REPOSITORY) private readonly organizers: OrganizerRepository) {}

  async execute(userId: string, orgId: string): Promise<AuthenticatedOrganizer> {
    const record = await this.organizers.findByIdInOrganization(userId, orgId);
    if (!record || record.deletedAt !== null || !record.membership) {
      throw new UnauthenticatedError('This session is no longer valid.');
    }
    return toAuthenticatedOrganizer(record);
  }
}
