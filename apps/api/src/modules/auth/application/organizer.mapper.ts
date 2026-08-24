import type { AuthenticatedOrganizer } from '@eventq/contracts';
import type { OrganizerRecord } from '../domain/organizer.repository';

/**
 * Maps the internal record to the public contract.
 *
 * This is the boundary that keeps `passwordHash`, `failedLoginCount` and
 * `lockedUntil` off the wire. Returning the record directly would leak all
 * three, so every response goes through here rather than being spread into JSON
 * at a call site.
 */
export function toAuthenticatedOrganizer(record: OrganizerRecord): AuthenticatedOrganizer {
  if (!record.membership) {
    // Only reachable if a caller mapped a record it should have rejected first.
    throw new Error('Cannot present an organizer with no organization membership.');
  }

  return {
    id: record.id,
    email: record.email,
    name: record.name,
    emailVerified: record.emailVerifiedAt !== null,
    organization: {
      id: record.membership.orgId,
      name: record.membership.orgName,
      slug: record.membership.orgSlug,
      role: record.membership.role,
    },
  };
}
