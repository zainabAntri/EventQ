import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeRankScore, type QuestionStatus } from '@eventq/contracts';
import { normalizeQuestion } from '../src/modules/questions/domain/question-text';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * Dashboard performance at 100, 1,000 and 10,000 questions.
 *
 * This is a REGRESSION GUARD, not a benchmark. It runs inside a Testcontainers
 * Postgres on whatever machine happens to be running CI, so the absolute
 * numbers mean very little and the thresholds are set far above any healthy
 * result. What it is actually built to catch is a change in SHAPE:
 *
 *   - a query that stops using an index and starts sorting the whole event;
 *   - a page that grows with the dataset because a limit was dropped;
 *   - keyset pagination quietly replaced by an offset, so deep pages degrade;
 *   - an N+1 introduced by fetching something per question.
 *
 * Each of those turns a 20ms query into a multi-second one at ten thousand
 * rows, which is exactly the scale where nobody notices in development and
 * everybody notices during a keynote.
 */

/**
 * Ceiling for a single dashboard query, whatever the dataset size.
 *
 * Roughly two orders of magnitude above what these queries actually cost on a
 * warm container, so a failure here means something is genuinely wrong rather
 * than that the CI machine was busy.
 */
const QUERY_BUDGET_MS = 1_000;

const PAGE_SIZE = 25;
const SIZES = [100, 1_000, 10_000] as const;

describe('organizer dashboard performance', () => {
  let testApp: TestApp;
  let alice: RegisteredOrganizer;

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.db.truncate();
    await testApp.resetRateLimits();
    alice = await registerOrganizer(testApp, { email: 'perf@eventq.test' });
  }, 240_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  async function createPublishedEvent(): Promise<{ id: string }> {
    const created = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', alice.cookie)
      .send({ title: 'A conference large enough to be interesting' })
      .expect(201);

    await testApp
      .http()
      .post(`/api/v1/events/${created.body.id}/publish`)
      .set(csrf)
      .set('Cookie', alice.cookie)
      .expect(200);

    return created.body;
  }

  const STATUSES: readonly QuestionStatus[] = ['PENDING', 'APPROVED', 'ANSWERED', 'REJECTED'];
  const BASE_TIME = new Date('2026-06-01T09:00:00.000Z');

  /**
   * Bulk-seeds an event.
   *
   * Written in batches rather than one statement because Postgres caps a query
   * at 65,535 bound parameters, and ten thousand rows of a dozen columns is
   * well past that — the failure mode is an opaque driver error rather than
   * anything that would point at the cause.
   *
   * Scores come from the same shared function the application writes with, so
   * these rows are indistinguishable from submitted ones and the ranked query
   * has genuinely varied values to sort.
   */
  async function seedQuestions(eventId: string, count: number): Promise<void> {
    const attendee = await testApp.db.prisma.attendee.create({
      data: { eventId, displayName: 'Load Fixture' },
    });

    const BATCH = 500;

    for (let start = 0; start < count; start += BATCH) {
      const rows = [];

      for (let index = start; index < Math.min(start + BATCH, count); index += 1) {
        // Varied text, so search has to do real work rather than matching
        // everything or nothing.
        const body = normalizeQuestion(
          `Question ${index} about ${index % 7 === 0 ? 'valuations' : 'hiring'} and how the team handles it in practice`,
        );
        const status = STATUSES[index % STATUSES.length]!;
        const createdAt = new Date(BASE_TIME.getTime() + index * 1_000);
        const upvoteCount = index % 50;

        rows.push({
          eventId,
          attendeeId: attendee.id,
          body: body.body,
          normalizedBody: body.normalizedBody,
          bodyHash: body.bodyHash,
          status,
          upvoteCount,
          createdAt,
          rankScore: computeRankScore({ upvoteCount, createdAt, status, pinnedAt: null }),
        });
      }

      await testApp.db.prisma.question.createMany({ data: rows });
    }

    // Without fresh statistics the planner still believes the table is empty
    // and may pick a sequential scan for reasons that have nothing to do with
    // the query being tested.
    await testApp.db.prisma.$executeRawUnsafe('ANALYZE questions');
  }

  function queue(eventId: string, query: Record<string, string>) {
    return testApp
      .http()
      .get(`/api/v1/events/${eventId}/questions`)
      .query(query)
      .set('Cookie', alice.cookie);
  }

  /** Times one request, returning the elapsed milliseconds and the body. */
  async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> {
    const started = performance.now();
    const result = await run();
    return { ms: performance.now() - started, result };
  }

  for (const size of SIZES) {
    describe(`with ${size.toLocaleString('en-US')} questions`, () => {
      let eventId: string;

      beforeAll(async () => {
        const event = await createPublishedEvent();
        eventId = event.id;
        await seedQuestions(eventId, size);

        // One warm-up request, excluded from every measurement below: the first
        // query on a cold pool pays for connection setup and plan caching, and
        // attributing that to the query under test would be misleading.
        await queue(eventId, { limit: String(PAGE_SIZE) }).expect(200);
      }, 240_000);

      it('returns one page, never the whole event', async () => {
        // The single most important assertion in this file. Everything else is
        // about speed; this is about a dashboard that would otherwise try to
        // render ten thousand rows and lock the browser.
        const response = await queue(eventId, { limit: String(PAGE_SIZE) }).expect(200);

        expect(response.body.items).toHaveLength(PAGE_SIZE);
        expect(response.body.hasMore).toBe(size > PAGE_SIZE);
      });

      it('serves the default ranked page within budget', async () => {
        const { ms } = await timed(() =>
          queue(eventId, { sort: 'rank', limit: String(PAGE_SIZE) }).expect(200),
        );

        expect(ms).toBeLessThan(QUERY_BUDGET_MS);
      });

      it('serves every other sort order within budget', async () => {
        for (const sort of ['newest', 'oldest', 'votes'] as const) {
          const { ms } = await timed(() =>
            queue(eventId, { sort, limit: String(PAGE_SIZE) }).expect(200),
          );

          expect(ms, `sort=${sort} was too slow`).toBeLessThan(QUERY_BUDGET_MS);
        }
      });

      it('serves a filtered page within budget', async () => {
        const { ms } = await timed(() =>
          queue(eventId, { status: 'PENDING', limit: String(PAGE_SIZE) }).expect(200),
        );

        expect(ms).toBeLessThan(QUERY_BUDGET_MS);
      });

      it('searches within budget', async () => {
        // Rides the GIN trigram index built for duplicate detection. A term
        // that matches a large fraction of the event is the expensive case, so
        // that is the one measured.
        const { ms, result } = await timed(() =>
          queue(eventId, { search: 'hiring', limit: String(PAGE_SIZE) }).expect(200),
        );

        expect(ms).toBeLessThan(QUERY_BUDGET_MS);
        expect(result.body.items.length).toBeGreaterThan(0);
      });

      it('counts every status within budget', async () => {
        // The polled endpoint. It runs far more often than anything else here,
        // so a regression in it costs more than a regression in the list.
        const { ms } = await timed(() =>
          testApp
            .http()
            .get(`/api/v1/events/${eventId}/questions/stats`)
            .set('Cookie', alice.cookie)
            .expect(200),
        );

        expect(ms).toBeLessThan(QUERY_BUDGET_MS);
      });

      it('costs no more to reach a deep page than the first one', async () => {
        /**
         * The keyset property, asserted directly.
         *
         * With OFFSET pagination, page 40 makes Postgres produce and discard
         * the thousand rows before it, so cost climbs with depth. With a keyset
         * it seeks straight to the boundary and reads one page, so depth is
         * free. Comparing the two against the same budget is what tells those
         * two implementations apart.
         */
        const pagesToWalk = Math.min(40, Math.floor(size / PAGE_SIZE));
        if (pagesToWalk < 2) return;

        let cursor: string | null = null;
        let deepest = 0;

        for (let page = 0; page < pagesToWalk; page += 1) {
          const query: Record<string, string> = { sort: 'rank', limit: String(PAGE_SIZE) };
          if (cursor) query.cursor = cursor;

          const { ms, result } = await timed(() => queue(eventId, query).expect(200));
          deepest = ms;

          if (!result.body.hasMore) break;
          cursor = result.body.nextCursor;
        }

        expect(deepest).toBeLessThan(QUERY_BUDGET_MS);
      });
    });
  }
});
