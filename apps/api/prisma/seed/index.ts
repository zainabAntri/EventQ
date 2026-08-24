import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import {
  SEED_ATTENDEES,
  SEED_EVENT,
  SEED_IDS,
  SEED_ORG,
  SEED_QUESTIONS,
  SEED_USERS,
} from './seed-data';

/**
 * Development seed.
 *
 * Two properties matter more than the data itself:
 *
 *   1. IDEMPOTENT. Every write is an upsert on a fixed id, so running this
 *      repeatedly converges on the same database instead of accumulating
 *      duplicates. Verified by the quality gate: seeding twice must produce
 *      identical row counts.
 *
 *   2. NO COMMITTED CREDENTIALS. The password is taken from SEED_PASSWORD or
 *      generated randomly, then printed once. A hard-coded password in a repo
 *      has a way of ending up in a deployed environment.
 *
 * Refuses to run against production, because a seed that can overwrite real
 * data is one environment variable away from being a very bad afternoon.
 */

function requireNonProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
}

function resolvePassword(): { password: string; generated: boolean } {
  const supplied = process.env.SEED_PASSWORD;
  if (supplied && supplied.length >= 12) {
    return { password: supplied, generated: false };
  }
  return { password: `dev-${randomBytes(9).toString('base64url')}`, generated: true };
}

/** Normalisation mirrors what the Question domain will do on submission. */
function normalize(body: string): string {
  return body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main(): Promise<void> {
  requireNonProduction();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const { password, generated } = resolvePassword();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  try {
    const org = await prisma.organization.upsert({
      where: { id: SEED_ORG.id },
      update: { name: SEED_ORG.name },
      create: { id: SEED_ORG.id, name: SEED_ORG.name, slug: SEED_ORG.slug },
    });

    for (const user of SEED_USERS) {
      await prisma.user.upsert({
        where: { id: user.id },
        update: { name: user.name, passwordHash },
        create: {
          id: user.id,
          email: user.email,
          name: user.name,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
      });

      await prisma.membership.upsert({
        where: { userId_orgId: { userId: user.id, orgId: org.id } },
        update: { role: user.role },
        create: { userId: user.id, orgId: org.id, role: user.role },
      });
    }

    await prisma.event.upsert({
      where: { id: SEED_EVENT.id },
      update: { title: SEED_EVENT.title, status: SEED_EVENT.status },
      create: {
        id: SEED_EVENT.id,
        orgId: org.id,
        title: SEED_EVENT.title,
        description: SEED_EVENT.description,
        joinCode: SEED_EVENT.joinCode,
        slug: SEED_EVENT.slug,
        type: SEED_EVENT.type,
        status: SEED_EVENT.status,
        timezone: 'Europe/London',
      },
    });

    await prisma.eventSettings.upsert({
      where: { eventId: SEED_EVENT.id },
      update: {},
      create: {
        eventId: SEED_EVENT.id,
        moderationMode: 'PRE',
        attendeeIdentityMode: 'OPTIONAL',
        // Explicitly off. No AI code exists and no API key is configured.
        aiEnabled: false,
      },
    });

    for (const attendee of SEED_ATTENDEES) {
      await prisma.attendee.upsert({
        where: { id: attendee.id },
        update: {},
        create: {
          id: attendee.id,
          eventId: SEED_EVENT.id,
          displayName: attendee.displayName,
          company: attendee.company,
        },
      });
    }

    for (const question of SEED_QUESTIONS) {
      const attendeeId = SEED_IDS.attendees[question.attendeeIndex];
      if (!attendeeId) throw new Error(`Bad attendeeIndex ${question.attendeeIndex}`);

      await prisma.question.upsert({
        where: { id: question.id },
        update: { status: question.status, upvoteCount: question.upvoteCount },
        create: {
          id: question.id,
          eventId: SEED_EVENT.id,
          attendeeId,
          body: question.body,
          normalizedBody: normalize(question.body),
          status: question.status,
          upvoteCount: question.upvoteCount,
        },
      });
    }

    const counts = {
      organizations: await prisma.organization.count(),
      users: await prisma.user.count(),
      events: await prisma.event.count(),
      attendees: await prisma.attendee.count(),
      questions: await prisma.question.count(),
    };

    console.warn('\nSeed complete.');
    console.warn(`  Join code : ${SEED_EVENT.joinCode}`);
    console.warn(`  Accounts  : ${SEED_USERS.map((u) => u.email).join(', ')}`);
    console.warn(
      generated
        ? `  Password  : ${password}   (generated - set SEED_PASSWORD to choose your own)`
        : '  Password  : taken from SEED_PASSWORD',
    );
    console.warn(`  Row counts: ${JSON.stringify(counts)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
