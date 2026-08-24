import { Injectable } from '@nestjs/common';
import type { OrgRole } from '@eventq/contracts';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  CreateOrganizerInput,
  LockoutUpdate,
  OrganizerRecord,
  OrganizerRepository,
} from '../domain/organizer.repository';

/**
 * Prisma adapter for OrganizerRepository.
 *
 * The only place in the auth module that knows Prisma exists.
 */
@Injectable()
export class PrismaOrganizerRepository implements OrganizerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<OrganizerRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: { orderBy: { createdAt: 'asc' }, take: 1, include: { org: true } },
      },
    });

    return user ? toRecord(user) : null;
  }

  async findByIdInOrganization(userId: string, orgId: string): Promise<OrganizerRecord | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { user: true, org: true },
    });

    if (!membership) return null;

    return toRecord({
      ...membership.user,
      memberships: [{ role: membership.role, org: membership.org }],
    });
  }

  async emailExists(email: string): Promise<boolean> {
    const found = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    return found !== null;
  }

  async createWithOrganization(input: CreateOrganizerInput): Promise<OrganizerRecord> {
    const created = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: input.organizationName, slug: await this.uniqueSlug(input.organizationName) },
      });

      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash: input.passwordHash },
      });

      // The registering user owns the organization they just created.
      const membership = await tx.membership.create({
        data: { userId: user.id, orgId: organization.id, role: 'OWNER' },
      });

      return { user, organization, role: membership.role };
    });

    return toRecord({
      ...created.user,
      memberships: [{ role: created.role, org: created.organization }],
    });
  }

  async applyLockout(userId: string, update: LockoutUpdate): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: update.failedLoginCount, lockedUntil: update.lockedUntil },
    });
  }

  async recordSuccessfulLogin(userId: string, newPasswordHash?: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(newPasswordHash ? { passwordHash: newPasswordHash } : {}),
      },
    });
  }

  /** Slugifies, then suffixes until free. */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'organization';

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }

    // Pathological case only; keeps the loop bounded rather than spinning.
    return `${base}-${Date.now().toString(36)}`;
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  memberships: Array<{ role: string; org: { id: string; name: string; slug: string } }>;
}

/** Maps a Prisma row to the domain shape, so no ORM type escapes this file. */
function toRecord(user: UserRow): OrganizerRecord {
  const membership = user.memberships[0];

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    emailVerifiedAt: user.emailVerifiedAt,
    deletedAt: user.deletedAt,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil,
    membership: membership
      ? {
          orgId: membership.org.id,
          orgName: membership.org.name,
          orgSlug: membership.org.slug,
          role: membership.role as OrgRole,
        }
      : null,
  };
}
