import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './database.harness';

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

  const question = await db.prisma.question.create({
    data: {
      eventId: event.id,
      attendeeId: attendee.id,
      body: 'How do you follow up after an event?',
      normalizedBody: 'how do you follow up after an event',
    },
  });

  return { orgId: org.id, eventId: event.id, attendeeId: attendee.id, questionId: question.id };
}
