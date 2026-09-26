import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './database.harness';
import { hashForComparison } from '../src/modules/questions/domain/question-text';

/**
 * Proves the schema infrastructure actually behaves as designed against a real
 * Postgres — the claims that a unit test structurally cannot make.
 */
describe('database schema', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('installs the extensions the architecture depends on', async () => {
    const rows = await db.prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension ORDER BY extname
    `;
    const names = rows.map((r) => r.extname);

    // pg_trgm powers duplicate detection at ZERO API cost; vector is reserved
    // for semantic similarity. Both must survive every future migration.
    expect(names).toContain('pg_trgm');
    expect(names).toContain('vector');
    expect(names).toContain('pgcrypto');
  });

  it('applies every migration cleanly', async () => {
    const rows = await db.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(19);
  });

  describe('closed to the Supabase Data API', () => {
    /**
     * Supabase serves every `public` table over PostgREST to anyone holding the
     * project's anon key, which is public by design. These tests pin the
     * 20260924100000_lock_public_schema migration's two layers.
     */
    it('enables row level security on every table — including any added later', async () => {
      const rows = await db.prisma.$queryRaw<Array<{ relname: string; rls: boolean }>>`
        SELECT relname, relrowsecurity AS rls FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      `;

      expect(rows.length).toBeGreaterThanOrEqual(19);
      // A failure here names the table whose migration forgot
      // `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
      expect(rows.filter((row) => !row.rls).map((row) => row.relname)).toEqual([]);
    });

    it('returns no rows to an API role even when it holds a SELECT grant', async () => {
      await seedMinimalEvent(db);
      await createApiRoles(db);

      const visible = await db.prisma.$transaction(async (tx) => {
        // Simulates Supabase's default grant, then reads as that role.
        await tx.$executeRawUnsafe('GRANT SELECT ON public.organizations TO anon');
        await tx.$executeRawUnsafe('SET LOCAL ROLE anon');
        const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          'SELECT count(*)::bigint AS count FROM public.organizations',
        );
        return Number(rows[0]?.count ?? -1);
      });

      expect(visible).toBe(0);
      // The owner — which is what Prisma connects as — is unaffected.
      expect(await db.prisma.organization.count()).toBe(1);
    });

    it('revokes what Supabase grants by default when the migration runs where the roles exist', async () => {
      await createApiRoles(db);
      await db.prisma.$executeRawUnsafe(
        'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated',
      );

      // Re-run the real migration file: on Supabase these roles exist when it
      // first runs, so its REVOKE branch must be exercised here or a mistake in
      // it would surface only in production.
      await db.prisma.$executeRawUnsafe(
        readFileSync(
          // cwd is apps/api under both turbo and a direct vitest run, as in
          // database.harness.ts.
          join(process.cwd(), 'prisma/migrations/20260924100000_lock_public_schema/migration.sql'),
          'utf8',
        ),
      );

      const rows = await db.prisma.$queryRaw<Array<{ granted: boolean }>>`
        SELECT has_table_privilege('anon', 'public.users', 'SELECT')
            OR has_table_privilege('authenticated', 'public.users', 'SELECT')
            OR has_table_privilege('anon', 'public.questions', 'INSERT') AS granted
      `;
      expect(rows[0]?.granted).toBe(false);
    });
  });

  it('makes double-voting structurally impossible', async () => {
    const { eventId, attendeeId, questionId } = await seedMinimalEvent(db);

    await db.prisma.questionVote.create({ data: { questionId, attendeeId } });

    // The guarantee is the unique index, not application code. If someone ever
    // drops it, this fails loudly instead of becoming a vote-stuffing bug.
    await expect(
      db.prisma.questionVote.create({ data: { questionId, attendeeId } }),
    ).rejects.toThrow();

    expect(await db.prisma.questionVote.count({ where: { questionId } })).toBe(1);
    expect(eventId).toBeTruthy();
  });

  it('scopes attendees to a single event so identity never spans events', async () => {
    const first = await seedMinimalEvent(db, 'EVENTAAA');
    const second = await seedMinimalEvent(db, 'EVENTBBB');

    const attendee = await db.prisma.attendee.findUniqueOrThrow({
      where: { id: first.attendeeId },
    });

    expect(attendee.eventId).toBe(first.eventId);
    expect(attendee.eventId).not.toBe(second.eventId);
  });

  it('cascades a deleted event to its questions, leaving no orphans', async () => {
    const { eventId } = await seedMinimalEvent(db);
    expect(await db.prisma.question.count()).toBe(1);

    await db.prisma.event.delete({ where: { id: eventId } });

    expect(await db.prisma.question.count()).toBe(0);
    expect(await db.prisma.attendee.count()).toBe(0);
  });

  it('finds near-duplicate questions with pg_trgm and no AI', async () => {
    const { eventId } = await seedMinimalEvent(db);

    const rows = await db.prisma.$queryRaw<Array<{ similarity: number }>>`
      SELECT similarity(
        'what is the best way to follow up after an event',
        'whats the best approach for following up after an event'
      ) AS similarity
    `;

    // Demonstrates the zero-cost first tier of duplicate detection works before
    // any model is involved.
    expect(rows[0]?.similarity).toBeGreaterThan(0.4);
    expect(eventId).toBeTruthy();
  });
});

/** Supabase's PostgREST roles. Roles are cluster-wide, so create only once. */
async function createApiRoles(db: TestDatabase): Promise<void> {
  await db.prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
  `);
}

/** Minimal valid object graph: org -> event -> attendee -> question. */
async function seedMinimalEvent(db: TestDatabase, joinCode = 'TESTCODE') {
  const org = await db.prisma.organization.create({
    data: { name: 'Test Org', slug: `org-${joinCode.toLowerCase()}` },
  });

  const event = await db.prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Test Event',
      joinCode,
      slug: `event-${joinCode.toLowerCase()}`,
      status: 'PUBLISHED',
      settings: { create: {} },
    },
  });

  const attendee = await db.prisma.attendee.create({ data: { eventId: event.id } });

  const normalizedBody = 'how do you follow up after an event';

  const question = await db.prisma.question.create({
    data: {
      eventId: event.id,
      attendeeId: attendee.id,
      body: 'How do you follow up after an event?',
      normalizedBody,
      // Computed with the real domain function rather than a literal, so this
      // fixture stays valid against the unique index that compares it.
      bodyHash: hashForComparison(normalizedBody),
    },
  });

  return { orgId: org.id, eventId: event.id, attendeeId: attendee.id, questionId: question.id };
}
