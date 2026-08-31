import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * The organizer dashboard, end to end.
 *
 * Two things are being tested here and they are not equally important.
 *
 * The filtering, sorting, search and pagination behaviour is ordinary product
 * correctness: get it wrong and a moderator has a frustrating afternoon.
 *
 * The isolation behaviour is not. EventQ is multi-tenant, and a question is
 * often the most sensitive thing at an event — an audience member asking
 * something pointed about a company, by name, before anyone has approved it.
 * One organization reading another's queue is the failure that ends the
 * product. So every read path added in this phase is asserted against a second
 * organization explicitly, including the ones that look obviously safe.
 */
describe('organizer dashboard', () => {
  let testApp: TestApp;
  let alice: RegisteredOrganizer;
  let bob: RegisteredOrganizer;
  let event: { id: string; joinCode: string };

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  beforeEach(async () => {
    await testApp.db.truncate();
    await testApp.resetRateLimits();
    alice = await registerOrganizer(testApp, { email: 'alice@eventq.test' });
    bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });
    event = await createPublishedEvent(alice);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createPublishedEvent(
    owner: RegisteredOrganizer,
    title = 'Founders and Funders Night',
  ): Promise<{ id: string; joinCode: string }> {
    const created = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ title })
      .expect(201);

    await testApp
      .http()
      .post(`/api/v1/events/${created.body.id}/publish`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .expect(200);

    return created.body;
  }

  interface QuestionSpec {
    body: string;
    status?: QuestionStatus;
    upvoteCount?: number;
    /** Minutes after a fixed base time, so ordering is deterministic. */
    minute?: number;
    pinned?: boolean;
  }

  const BASE_TIME = new Date('2026-06-01T09:00:00.000Z');

  /**
   * Seeds questions directly, bypassing the submit endpoint.
   *
   * Deliberate: these tests need exact control over status, vote count and
   * creation time, none of which an attendee can set — that is the whole point
   * of the submit contract. The write path itself is covered by the Phase 3
   * suite and, for the score specifically, by "stores a score it can recompute
   * from the row" below.
   *
   * `rankScore` is computed with the same shared function the application uses,
   * so a seeded row is indistinguishable from a submitted one.
   */
  async function seed(eventId: string, specs: QuestionSpec[]): Promise<string[]> {
    const attendee = await testApp.db.prisma.attendee.create({
      data: { eventId, displayName: 'Sam Okafor' },
    });

    const ids: string[] = [];

    for (const spec of specs) {
      const normalized = normalizeQuestion(spec.body);
      const status = spec.status ?? 'PENDING';
      const createdAt = new Date(BASE_TIME.getTime() + (spec.minute ?? 0) * 60_000);
      const pinnedAt = spec.pinned ? createdAt : null;

      const created = await testApp.db.prisma.question.create({
        data: {
          eventId,
          attendeeId: attendee.id,
          body: normalized.body,
          normalizedBody: normalized.normalizedBody,
          bodyHash: normalized.bodyHash,
          status,
          upvoteCount: spec.upvoteCount ?? 0,
          createdAt,
          pinnedAt,
          // ARCHIVED is the soft-deleted state, so the two must agree or the
          // fixture would describe a row the application can never produce.
          deletedAt: status === 'ARCHIVED' ? createdAt : null,
          rankScore: computeRankScore({
            upvoteCount: spec.upvoteCount ?? 0,
            createdAt,
            status,
            pinnedAt,
          }),
        },
        select: { id: true },
      });

      ids.push(created.id);
    }

    return ids;
  }

  function queue(owner: RegisteredOrganizer, eventId: string, query: Record<string, string> = {}) {
    return testApp
      .http()
      .get(`/api/v1/events/${eventId}/questions`)
      .query(query)
      .set('Cookie', owner.cookie);
  }

  function stats(owner: RegisteredOrganizer, eventId: string) {
    return testApp
      .http()
      .get(`/api/v1/events/${eventId}/questions/stats`)
      .set('Cookie', owner.cookie);
  }

  function moderate(owner: RegisteredOrganizer, questionId: string, action: string) {
    return testApp
      .http()
      .post(`/api/v1/questions/${questionId}/moderate`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ action });
  }

  const bodies = (response: { body: { items: Array<{ body: string }> } }) =>
    response.body.items.map((item) => item.body);

  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    /**
     * The requirement, stated plainly: organizer A must never receive a
     * question belonging to organizer B.
     *
     * Every assertion below expects an EMPTY PAGE rather than a 403. A 403
     * would confirm the event id is real and turn the endpoint into an
     * enumeration oracle — the same reasoning that already governs the
     * single-question lookup. Absence of data and absence of permission must
     * look identical from outside.
     */
    it("returns nothing when one organizer reads another organization's queue", async () => {
      await seed(event.id, [{ body: 'What does your due diligence process look like?' }]);

      const mine = await queue(alice, event.id).expect(200);
      const theirs = await queue(bob, event.id).expect(200);

      expect(mine.body.items).toHaveLength(1);
      expect(theirs.body.items).toEqual([]);
      expect(theirs.body.hasMore).toBe(false);
      expect(theirs.body.nextCursor).toBeNull();
    });

    it('leaks nothing through the status filter', async () => {
      await seed(event.id, [
        { body: 'A question that is waiting for review right now', status: 'PENDING' },
        { body: 'A question that has already been approved for the room', status: 'APPROVED' },
        { body: 'A question somebody rejected earlier this morning', status: 'REJECTED' },
        { body: 'A question that was quarantined as spam automatically', status: 'SPAM' },
        { body: 'A question that was answered from the stage already', status: 'ANSWERED' },
        { body: 'A question that was archived and removed from view', status: 'ARCHIVED' },
      ]);

      // Every status, including the ones that are normally hidden. A filter is
      // a new query shape, and a new query shape is a new chance to forget the
      // organization predicate.
      for (const status of [
        'PENDING',
        'APPROVED',
        'REJECTED',
        'SPAM',
        'ANSWERED',
        'ARCHIVED',
      ] as const) {
        const response = await queue(bob, event.id, { status }).expect(200);
        expect(response.body.items, `status=${status} leaked`).toEqual([]);
      }
    });

    it('leaks nothing through search, which is the easiest way in', async () => {
      // Search is the one filter an attacker fully controls the text of, so a
      // missing scope here would let someone fish for a known phrase across
      // every event on the platform.
      await seed(event.id, [{ body: 'Confidential question about the Q3 acquisition talks' }]);

      const response = await queue(bob, event.id, { search: 'acquisition' }).expect(200);

      expect(response.body.items).toEqual([]);
    });

    it('leaks nothing through any sort order', async () => {
      await seed(event.id, [
        { body: 'How much runway do you have left right now?', upvoteCount: 9 },
      ]);

      for (const sort of ['rank', 'newest', 'oldest', 'votes'] as const) {
        const response = await queue(bob, event.id, { sort }).expect(200);
        expect(response.body.items, `sort=${sort} leaked`).toEqual([]);
      }
    });

    it('leaks nothing through a cursor minted inside the other organization', async () => {
      // A cursor is opaque but unsigned, and this is the test that says why
      // that is acceptable: it names a position, not an authority, so replaying
      // one stolen from another tenant still returns nothing.
      await seed(event.id, [
        { body: 'The first of two questions asked during the panel', minute: 0 },
        { body: 'The second of two questions asked during the panel', minute: 5 },
      ]);

      const page = await queue(alice, event.id, { limit: '1' }).expect(200);
      expect(page.body.nextCursor).toBeTruthy();

      const replayed = await queue(bob, event.id, {
        limit: '1',
        cursor: page.body.nextCursor,
      }).expect(200);

      expect(replayed.body.items).toEqual([]);
    });

    it("reports all zeros when reading another organization's counts", async () => {
      await seed(event.id, [
        { body: 'A question that is waiting for review right now', status: 'PENDING' },
        { body: 'A question that has already been approved for the room', status: 'APPROVED' },
      ]);

      const theirs = await stats(bob, event.id).expect(200);

      // Not a 404: the counts endpoint must be as unrevealing as the list.
      expect(theirs.body.total).toBe(0);
      expect(Object.values(theirs.body.counts)).toEqual(
        Object.values(theirs.body.counts).map(() => 0),
      );
    });

    it('refuses to moderate a question belonging to another organization', async () => {
      const [questionId] = await seed(event.id, [
        { body: 'Would you invest in a competitor of one of your portfolio companies?' },
      ]);

      // 404, not 403 — for the same reason the reads return empty pages.
      await moderate(bob, questionId!, 'approve').expect(404);

      // And the question is untouched, so the refusal is real rather than
      // cosmetic: a write that 404s but still commits would be far worse than
      // one that returns 403.
      const after = await queue(alice, event.id).expect(200);
      expect(after.body.items[0].status).toBe('PENDING');
    });

    it('keeps two organizations apart when both hold identical question text', async () => {
      // Body text is the only field a tenant fully controls, so identical text
      // across tenants is the case where a missing predicate would surface as
      // "my question count doubled" rather than as an obvious leak.
      const theirEvent = await createPublishedEvent(bob, 'A completely separate conference');
      const shared = 'What is the single biggest mistake founders make when fundraising?';

      await seed(event.id, [{ body: shared }]);
      await seed(theirEvent.id, [{ body: shared }]);

      const hers = await queue(alice, event.id, { search: 'fundraising' }).expect(200);
      const his = await queue(bob, theirEvent.id, { search: 'fundraising' }).expect(200);

      expect(hers.body.items).toHaveLength(1);
      expect(his.body.items).toHaveLength(1);
      expect(hers.body.items[0].id).not.toBe(his.body.items[0].id);

      // Each sees exactly one — the cross-tenant row is not merely ordered
      // last, it is absent.
      expect(hers.body.items[0].eventId).toBe(event.id);
      expect(his.body.items[0].eventId).toBe(theirEvent.id);
    });

    it('still requires authentication at all', async () => {
      await testApp.http().get(`/api/v1/events/${event.id}/questions`).expect(401);
      await testApp.http().get(`/api/v1/events/${event.id}/questions/stats`).expect(401);
    });
  });

  // ---------------------------------------------------------------------------

  describe('filtering', () => {
    beforeEach(async () => {
      await seed(event.id, [
        { body: 'A question that is waiting for review right now', status: 'PENDING' },
        { body: 'A question that has already been approved for the room', status: 'APPROVED' },
        { body: 'A question that was answered from the stage already', status: 'ANSWERED' },
        { body: 'A question somebody rejected earlier this morning', status: 'REJECTED' },
        { body: 'A question that was archived and removed from view', status: 'ARCHIVED' },
      ]);
    });

    it('returns only the requested status', async () => {
      const response = await queue(alice, event.id, { status: 'APPROVED' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].status).toBe('APPROVED');
    });

    it('hides archived questions from the unfiltered queue', async () => {
      // ARCHIVED is the soft delete. A question someone deliberately removed
      // reappearing in the default view would make the action look broken.
      const response = await queue(alice, event.id).expect(200);

      expect(response.body.items).toHaveLength(4);
      expect(bodies(response).some((body) => body.includes('archived'))).toBe(false);
    });

    it('shows archived questions only when asked for by name', async () => {
      const response = await queue(alice, event.id, { status: 'ARCHIVED' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].status).toBe('ARCHIVED');
    });

    it('offers no actions on an archived question', async () => {
      // Archived is terminal in the state machine, so the dashboard must render
      // no buttons at all rather than buttons that return 422.
      const response = await queue(alice, event.id, { status: 'ARCHIVED' }).expect(200);

      expect(response.body.items[0].allowedActions).toEqual([]);
    });

    it('offers restore on a rejected question and approve on an answered one', async () => {
      const rejected = await queue(alice, event.id, { status: 'REJECTED' }).expect(200);
      const answered = await queue(alice, event.id, { status: 'ANSWERED' }).expect(200);

      expect(rejected.body.items[0].allowedActions).toContain('restore');
      // Restoring returns a question to the queue rather than publishing it, so
      // approve must NOT be offered as a one-click undo.
      expect(rejected.body.items[0].allowedActions).not.toContain('approve');
      expect(answered.body.items[0].allowedActions).toContain('approve');
    });
  });

  // ---------------------------------------------------------------------------

  describe('sorting', () => {
    it('ranks by blended score rather than insertion order', async () => {
      // The oldest question has the most support and must beat two newer,
      // quieter ones. Insertion order would put it last.
      await seed(event.id, [
        {
          body: 'The oldest question here, and the one the room wants most',
          minute: 0,
          upvoteCount: 60,
        },
        { body: 'A newer question that nobody has voted for at all yet', minute: 30 },
        { body: 'The newest question, also with no support behind it', minute: 60 },
      ]);

      const response = await queue(alice, event.id, { sort: 'rank' }).expect(200);

      expect(bodies(response)[0]).toContain('the room wants most');
    });

    it('puts a pinned question above everything, whatever its support', async () => {
      await seed(event.id, [
        {
          body: 'A wildly popular question with a great deal of support',
          minute: 0,
          upvoteCount: 500,
        },
        { body: 'The question the organizer wants asked next on stage', minute: 0, pinned: true },
      ]);

      const response = await queue(alice, event.id, { sort: 'rank' }).expect(200);

      expect(bodies(response)[0]).toContain('organizer wants asked next');
    });

    it('orders newest first, and oldest first as its exact reverse', async () => {
      await seed(event.id, [
        { body: 'The earliest question of the three asked this session', minute: 0 },
        { body: 'The middle question of the three asked this session', minute: 30 },
        { body: 'The latest question of the three asked this session', minute: 60 },
      ]);

      const newest = await queue(alice, event.id, { sort: 'newest' }).expect(200);
      const oldest = await queue(alice, event.id, { sort: 'oldest' }).expect(200);

      expect(bodies(newest)[0]).toContain('latest');
      expect(bodies(oldest)).toEqual([...bodies(newest)].reverse());
    });

    it('orders by vote count, ignoring recency entirely', async () => {
      await seed(event.id, [
        {
          body: 'An old question carrying the most support in the room',
          minute: 0,
          upvoteCount: 40,
        },
        { body: 'A brand new question that nobody has voted for yet', minute: 90, upvoteCount: 0 },
        {
          body: 'A middling question with a handful of votes behind it',
          minute: 45,
          upvoteCount: 12,
        },
      ]);

      const response = await queue(alice, event.id, { sort: 'votes' }).expect(200);

      expect(response.body.items.map((item: { upvoteCount: number }) => item.upvoteCount)).toEqual([
        40, 12, 0,
      ]);
    });

    it('rejects a sort it does not offer rather than silently ignoring it', async () => {
      await queue(alice, event.id, { sort: 'whatever-i-like' }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(async () => {
      await seed(event.id, [
        { body: 'How do you evaluate a founding team before the product exists?' },
        { body: 'What happened at the Café meetup in Lisbon last November?' },
        { body: 'Do you invest outside your usual sector when the team is strong?' },
      ]);
    });

    it('finds a question by a word inside it', async () => {
      const response = await queue(alice, event.id, { search: 'founding' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(bodies(response)[0]).toContain('founding team');
    });

    it('ignores case and accents, matching what was actually stored', async () => {
      // Search runs against the normalised body — the same folded text that
      // powers duplicate detection — so a moderator does not have to reproduce
      // the accent to find the question.
      const response = await queue(alice, event.id, { search: 'cafe' }).expect(200);

      expect(bodies(response)[0]).toContain('Café');
    });

    it('returns an empty page when nothing matches', async () => {
      const response = await queue(alice, event.id, { search: 'cryptocurrency' }).expect(200);

      expect(response.body.items).toEqual([]);
    });

    it('treats a wildcard as text rather than as a pattern', async () => {
      /**
       * `%` is a LIKE wildcard, and this term is built so the two readings give
       * opposite answers.
       *
       * As a PATTERN, `%founding%exists%` matches "How do you evaluate a
       * founding team before the product exists?" — the wildcard bridges the
       * words in between.
       *
       * As TEXT, normalisation turns it into "founding exists", which appears
       * in no question, so nothing matches. That is the correct behaviour, and
       * it comes for free: the normaliser keeps only letters, numbers and
       * single spaces, so a LIKE metacharacter cannot survive into the query.
       */
      const response = await queue(alice, event.id, { search: 'founding%exists' }).expect(200);

      expect(response.body.items).toEqual([]);
    });

    it('returns nothing for a term made entirely of punctuation', async () => {
      // Normalises to an empty string, which as a LIKE pattern would match
      // every question on the event. An empty result is the honest answer.
      const response = await queue(alice, event.id, { search: '???' }).expect(200);

      expect(response.body.items).toEqual([]);
    });

    it('rejects a single-character term instead of scanning the whole event', async () => {
      await queue(alice, event.id, { search: 'a' }).expect(400);
    });

    it('combines with a status filter rather than replacing it', async () => {
      await seed(event.id, [
        { body: 'An approved question that also mentions the founding story', status: 'APPROVED' },
      ]);

      const response = await queue(alice, event.id, {
        search: 'founding',
        status: 'APPROVED',
      }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].status).toBe('APPROVED');
    });
  });

  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    /**
     * Paginating a list that is also being moderated is where the subtle bugs
     * live: a page boundary landing inside a group of tied rows silently
     * repeats or drops questions, and nothing in the UI would reveal it.
     *
     * Every case below therefore walks the WHOLE list and asserts the union,
     * rather than checking that page two looks plausible.
     */
    async function walk(sort: string, limit = 4): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 50; page += 1) {
        const query: Record<string, string> = { sort, limit: String(limit) };
        if (cursor) query.cursor = cursor;

        const response = await queue(alice, event.id, query).expect(200);
        seen.push(...response.body.items.map((item: { id: string }) => item.id));

        if (!response.body.hasMore) return seen;
        cursor = response.body.nextCursor;
        expect(cursor, 'hasMore was true but no cursor was returned').toBeTruthy();
      }

      throw new Error('Pagination did not terminate');
    }

    it('visits every question exactly once across pages, in every sort order', async () => {
      const ids = await seed(
        event.id,
        Array.from({ length: 23 }, (_, index) => ({
          body: `Question number ${index} about the panel discussion earlier today`,
          minute: index,
          // Deliberately repetitive: most questions at a real event have zero
          // votes, so ties are the normal case and not an edge case.
          upvoteCount: index % 3,
        })),
      );

      for (const sort of ['rank', 'newest', 'oldest', 'votes']) {
        const walked = await walk(sort);

        expect(walked, `${sort} did not return every question`).toHaveLength(ids.length);
        expect(new Set(walked).size, `${sort} repeated a question`).toBe(ids.length);
        expect([...walked].sort()).toEqual([...ids].sort());
      }
    });

    it('holds a page boundary steady through a run of identical vote counts', async () => {
      // Every question ties on votes, so ordering rests entirely on the id
      // tiebreak. Without it Postgres may return tied rows in any order it
      // likes, differently per call, and rows fall between pages.
      const ids = await seed(
        event.id,
        Array.from({ length: 12 }, (_, index) => ({
          body: `An entirely unremarkable question, the ${index}th of its kind`,
          upvoteCount: 0,
          minute: index,
        })),
      );

      const walked = await walk('votes', 5);

      expect(new Set(walked).size).toBe(ids.length);
    });

    it('reports the last page without a cursor', async () => {
      await seed(event.id, [{ body: 'The only question anybody thought to ask today' }]);

      const response = await queue(alice, event.id, { limit: '10' }).expect(200);

      expect(response.body.hasMore).toBe(false);
      expect(response.body.nextCursor).toBeNull();
    });

    it('refuses a cursor minted for a different sort order', async () => {
      // The failure this prevents is silent: a rank cursor holds a score near
      // a billion, and comparing it against a vote count would return an
      // arbitrary page rather than an error.
      await seed(event.id, [
        { body: 'The first question of two, asked at the very start', minute: 0 },
        { body: 'The second question of two, asked a little later on', minute: 5 },
      ]);

      const page = await queue(alice, event.id, { sort: 'rank', limit: '1' }).expect(200);

      await queue(alice, event.id, { sort: 'votes', cursor: page.body.nextCursor }).expect(400);
    });

    it('refuses a malformed cursor as a client error, not a server fault', async () => {
      await queue(alice, event.id, { cursor: 'obviously-not-a-cursor' }).expect(400);
    });

    it('caps the page size a client may ask for', async () => {
      await queue(alice, event.id, { limit: '5000' }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------

  describe('moderation', () => {
    it('walks a question through approve, answer and archive', async () => {
      const [questionId] = await seed(event.id, [
        { body: 'How do you decide which follow-on rounds to participate in?' },
      ]);

      const approved = await moderate(alice, questionId!, 'approve').expect(200);
      expect(approved.body.status).toBe('APPROVED');

      const answered = await moderate(alice, questionId!, 'answer').expect(200);
      expect(answered.body.status).toBe('ANSWERED');
      expect(answered.body.answeredAt).not.toBeNull();

      const archived = await moderate(alice, questionId!, 'archive').expect(200);
      expect(archived.body.status).toBe('ARCHIVED');

      // Terminal: the question is gone from every ordinary read.
      const remaining = await queue(alice, event.id).expect(200);
      expect(remaining.body.items).toEqual([]);
    });

    it('clears the answered timestamp when a question is put back on the board', async () => {
      // Reopening a question answered by mistake must not leave it reporting
      // when it was answered — the dashboard shows that timestamp.
      const [questionId] = await seed(event.id, [
        {
          body: 'Was that last answer about the valuation cap actually right?',
          status: 'APPROVED',
        },
      ]);

      await moderate(alice, questionId!, 'answer').expect(200);
      const reopened = await moderate(alice, questionId!, 'approve').expect(200);

      expect(reopened.body.status).toBe('APPROVED');
      expect(reopened.body.answeredAt).toBeNull();
    });

    it('restores a rejected question to the queue rather than to the room', async () => {
      const [questionId] = await seed(event.id, [
        { body: 'A question rejected in error during a busy moment', status: 'REJECTED' },
      ]);

      const restored = await moderate(alice, questionId!, 'restore').expect(200);

      // PENDING, not APPROVED. Undoing a mistake must not be a faster route to
      // publication than the ordinary one.
      expect(restored.body.status).toBe('PENDING');
    });

    it('refuses an action that is not legal from the current state', async () => {
      const [questionId] = await seed(event.id, [
        { body: 'A question that was archived and removed from view', status: 'ARCHIVED' },
      ]);

      // Archived is terminal, and archiving also soft-deletes, so the question
      // is not merely un-actionable — it is unreachable.
      await moderate(alice, questionId!, 'restore').expect(404);
    });

    it('moves the stored rank score when a decision changes the status', async () => {
      const [questionId] = await seed(event.id, [
        { body: 'A question about hiring that is about to be answered', status: 'APPROVED' },
      ]);

      const before = await queue(alice, event.id, { status: 'APPROVED' }).expect(200);
      await moderate(alice, questionId!, 'answer').expect(200);
      const after = await queue(alice, event.id, { status: 'ANSWERED' }).expect(200);

      // Answering sinks a question a whole tier, so this is a large move rather
      // than a rounding difference.
      expect(after.body.items[0].rankScore).toBeLessThan(before.body.items[0].rankScore);
    });
  });

  // ---------------------------------------------------------------------------

  describe('counts and change detection', () => {
    it('counts every status, including zeros', async () => {
      await seed(event.id, [
        { body: 'A question that is waiting for review right now', status: 'PENDING' },
        { body: 'A second question also waiting for a moderator to look', status: 'PENDING' },
        { body: 'A question that has already been approved for the room', status: 'APPROVED' },
      ]);

      const response = await stats(alice, event.id).expect(200);

      expect(response.body.counts.PENDING).toBe(2);
      expect(response.body.counts.APPROVED).toBe(1);
      // Present and zero rather than absent, so a client never has to tell
      // "none" apart from "not reported".
      expect(response.body.counts.SPAM).toBe(0);
      expect(response.body.total).toBe(3);
    });

    it('excludes archived questions from the headline total', async () => {
      // The unfiltered queue excludes them, so a total that included them would
      // promise rows the list does not return.
      await seed(event.id, [
        { body: 'A question that is waiting for review right now', status: 'PENDING' },
        { body: 'A question that was archived and removed from view', status: 'ARCHIVED' },
      ]);

      const response = await stats(alice, event.id).expect(200);

      expect(response.body.total).toBe(1);
      // But still counted on its own tab, which needs a badge.
      expect(response.body.counts.ARCHIVED).toBe(1);
    });

    it('changes its version when a question is added', async () => {
      const before = await stats(alice, event.id).expect(200);
      await seed(event.id, [{ body: 'A brand new question that has just arrived' }]);
      const after = await stats(alice, event.id).expect(200);

      expect(after.body.version).not.toBe(before.body.version);
    });

    it('changes its version when a question is moderated but none is added', async () => {
      // The case a row count alone would miss, and the reason the token also
      // carries a timestamp: approving a question adds nothing and removes
      // nothing, but a dashboard must still refresh.
      const [questionId] = await seed(event.id, [
        { body: 'A question waiting to be approved for the room to see' },
      ]);

      const before = await stats(alice, event.id).expect(200);
      await moderate(alice, questionId!, 'approve').expect(200);
      const after = await stats(alice, event.id).expect(200);

      expect(after.body.version).not.toBe(before.body.version);
    });

    it('holds its version steady when nothing has happened', async () => {
      // The property that makes polling cheap: an unchanged version means the
      // dashboard skips the list query entirely.
      await seed(event.id, [{ body: 'A question that nobody is going to touch at all' }]);

      const first = await stats(alice, event.id).expect(200);
      const second = await stats(alice, event.id).expect(200);

      expect(second.body.version).toBe(first.body.version);
    });
  });

  // ---------------------------------------------------------------------------

  describe('rank score integrity', () => {
    it('stores a score it can recompute from the row it stored', async () => {
      /**
       * The assertion that keeps the stored column honest.
       *
       * A question submitted through the real endpoint is read back, and its
       * score recomputed from its own returned fields using the shared
       * function. They must match exactly — not approximately — because the
       * score is a cursor key, and a cursor that does not land precisely on a
       * stored value skips rows at the page boundary.
       *
       * This is also what makes the migration's one-off SQL backfill safe to
       * leave as a separate implementation: nothing writes scores that way
       * again, and if it ever diverged, this test would catch the runtime path
       * that matters.
       */
      const joined = await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/attendee`)
        .set(csrf)
        .expect(201);

      const token = (joined.headers['set-cookie'] as unknown as string[])
        .find((entry) => entry.startsWith('eq_pt='))!
        .split(';')[0]!
        .split('=')[1]!;

      await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/questions`)
        .set(csrf)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'What is the fastest way to get a first meeting with you?' })
        .expect(201);

      const response = await queue(alice, event.id).expect(200);
      const question = response.body.items[0];

      expect(question.rankScore).toBe(
        computeRankScore({
          upvoteCount: question.upvoteCount,
          createdAt: question.createdAt,
          status: question.status,
          pinnedAt: question.pinnedAt,
        }),
      );
    });

    it('returns the category field as null while AI enrichment is switched off', async () => {
      // "Category if available" — and with AI off, which is the default and the
      // only mode shipped, it is never available. The field exists so the
      // dashboard can render it the moment anything writes one.
      await seed(event.id, [{ body: 'A perfectly ordinary question about the roadmap' }]);

      const response = await queue(alice, event.id).expect(200);

      expect(response.body.items[0].category).toBeNull();
    });
  });
});
