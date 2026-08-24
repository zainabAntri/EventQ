import type { OrgRole } from '@eventq/contracts';

/**
 * Port: organizer persistence.
 *
 * Plain data in, plain data out — no Prisma types cross this boundary, so the
 * use-cases stay testable with an in-memory fake and know nothing about how
 * rows are stored.
 */

export interface OrganizerMembership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
}

export interface OrganizerRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** The organization this organizer acts within; null if they have none. */
  membership: OrganizerMembership | null;
}

export interface CreateOrganizerInput {
  email: string;
  name: string;
  passwordHash: string;
  organizationName: string;
}

export interface LockoutUpdate {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface OrganizerRepository {
  findByEmail(email: string): Promise<OrganizerRecord | null>;

  /** Resolves a user within a specific organization. Returns null if the
   *  membership no longer exists — a live token can outlive the authority it
   *  represents, and that must be caught rather than trusted. */
  findByIdInOrganization(userId: string, orgId: string): Promise<OrganizerRecord | null>;

  emailExists(email: string): Promise<boolean>;

  /** Creates the organizer, their organization and an OWNER membership
   *  atomically. A half-created account cannot do anything. */
  createWithOrganization(input: CreateOrganizerInput): Promise<OrganizerRecord>;

  applyLockout(userId: string, update: LockoutUpdate): Promise<void>;

  /** Clears the lockout counters, optionally upgrading the stored hash. */
  recordSuccessfulLogin(userId: string, newPasswordHash?: string): Promise<void>;
}

export const ORGANIZER_REPOSITORY = Symbol('ORGANIZER_REPOSITORY');
