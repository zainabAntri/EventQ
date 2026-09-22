import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeRankScore, ProblemDetails } from '@eventq/contracts';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * Attendee voting, end to end.
 *
 * The question under every test here is the same: what is "one person" when
 * nobody has an account? The answer the API gives is "one signed, event-scoped
 * attendee token", and most of what follows pushes on that from the directions
 * an abuser would — repeating, racing, refreshing, switching devices, crossing
 * events — and checks that the count on the question always equals the number
 * of vote rows. That equality is the whole correctness story: the counter is
 * denormalised for read speed, and a denormalised number that can drift is a
 * bug waiting for a live event.
 */
describe('attendee voting', () => {
  let testApp: TestApp;
  let alice: RegisteredOrganizer;
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
    // POST-moderated, so a submitted question is on the board immediately and
    // can be voted on without a moderator step in every test.
    event = await createPublishedEvent(alice, { settings: { moderationMode: 'POST' } });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createPublishedEvent(
    owner: RegisteredOrganizer,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string }> {
    const created = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ title: 'Founders and Funders Night', ...body })
      .expect(201);

    await testApp
      .http()
      .post(`/api/v1/events/${created.body.id}/publish`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .expect(200);

    return created.body;
  }

  /** Joins as a fresh device and returns the token — see questions spec for why
   *  it is read from Set-Cookie and presented as Bearer. */
  async function join(joinCode: string, existingToken?: string): Promise<string> {
    let request = testApp.http().post(`/api/v1/public/events/${joinCode}/attendee`).set(csrf);
    if (existingToken) request = request.set('Authorization', `Bearer ${existingToken}`);

    const response = await request.expect(201);
    const cookies = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const attendeeCookie = cookies.find((entry) => entry.startsWith('eq_pt='));
    if (!attendeeCookie) throw new Error('Join returned no attendee cookie');

    return attendeeCookie.split(';')[0]!.split('=')[1]!;
  }

  async function ask(joinCode: string, token: string, body: string): Promise<string> {
    const response = await testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/questions`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`)
      .send({ body })
      .expect(201);

    return response.body.id;
  }

  function vote(joinCode: string, token: string, questionId: string) {
    return testApp
      .http()
      .put(`/api/v1/public/events/${joinCode}/questions/${questionId}/vote`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`);
  }

  function unvote(joinCode: string, token: string, questionId: string) {
    return testApp
      .http()
      .delete(`/api/v1/public/events/${joinCode}/questions/${questionId}/vote`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`);
  }

  function board(joinCode: string, token: string) {
    return testApp
      .http()
      .get(`/api/v1/public/events/${joinCode}/questions`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** The two numbers that must never disagree. */
  async function countsFor(questionId: string): Promise<{ stored: number; rows: number }> {
    const question = await testApp.db.prisma.question.findUniqueOrThrow({
      where: { id: questionId },
      select: { upvoteCount: true },
    });
    const rows = await testApp.db.prisma.questionVote.count({ where: { questionId } });
    return { stored: question.upvoteCount, rows };
  }

  const ASKED = 'How do you follow up after meeting someone at an event like this?';

  // ---------------------------------------------------------------------------

  describe('a single vote', () => {
    it('records support and reports it back', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      const response = await vote(event.joinCode, voter, questionId).expect(200);

      expect(response.body).toEqual({ questionId, upvoteCount: 1, hasVoted: true });
      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });

    it('moves the ranking score, using the same formula as everything else', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      const before = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: questionId },
      });
      await vote(event.joinCode, voter, questionId).expect(200);
      const after = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: questionId },
      });

      expect(after.rankScore).toBeGreaterThan(before.rankScore);
      // Recomputed from the stored row: the score on disk IS the shared
      // function applied to the columns on disk, not an adjustment to it.
      expect(after.rankScore).toBe(
        computeRankScore({
          upvoteCount: 1,
          askedByCount: after.askedByCount,
          createdAt: after.createdAt,
          status: after.status,
          pinnedAt: after.pinnedAt,
        }),
      );
    });

    it('can be withdrawn, and the count comes back down', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      await vote(event.joinCode, voter, questionId).expect(200);
      const response = await unvote(event.joinCode, voter, questionId).expect(200);

      expect(response.body).toEqual({ questionId, upvoteCount: 0, hasVoted: false });
      expect(await countsFor(questionId)).toEqual({ stored: 0, rows: 0 });
    });

    it('shows on the board as hasVoted for the voter and not for anyone else', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);
      const bystander = await join(event.joinCode);

      await vote(event.joinCode, voter, questionId).expect(200);

      const mine = await board(event.joinCode, voter).expect(200);
      const theirs = await board(event.joinCode, bystander).expect(200);

      expect(mine.body.items[0]).toMatchObject({ id: questionId, upvoteCount: 1, hasVoted: true });
      expect(theirs.body.items[0]).toMatchObject({
        id: questionId,
        upvoteCount: 1,
        hasVoted: false,
      });
    });
  });

  describe('repeated voting', () => {
    it('counts a second vote from the same attendee exactly zero times', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      await vote(event.joinCode, voter, questionId).expect(200);
      const repeat = await vote(event.joinCode, voter, questionId).expect(200);

      // Not a 409. A retry on venue wifi and a deliberate repeat look identical
      // from here, and refusing the honest one is worse than tolerating the
      // other — so both simply get the state that already exists.
      expect(repeat.body).toEqual({ questionId, upvoteCount: 1, hasVoted: true });
      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });

    it('is harmless to withdraw a vote that was never cast', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      const response = await unvote(event.joinCode, voter, questionId).expect(200);

      expect(response.body).toEqual({ questionId, upvoteCount: 0, hasVoted: false });
      expect(await countsFor(questionId)).toEqual({ stored: 0, rows: 0 });
    });

    it('survives being toggled on and off many times', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      for (let round = 0; round < 5; round += 1) {
        await vote(event.joinCode, voter, questionId).expect(200);
        await unvote(event.joinCode, voter, questionId).expect(200);
      }
      await vote(event.joinCode, voter, questionId).expect(200);

      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });

    it('rate limits an attendee who flips a vote at machine speed', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      // The per-attendee allowance is 30 changes a minute. Every request here
      // is idempotent so the count never moves; what is being asserted is that
      // the endpoint stops answering at all, which is what bounds a script.
      const results = [];
      for (let attempt = 0; attempt < 32; attempt += 1) {
        results.push(await vote(event.joinCode, voter, questionId));
      }

      const limited = results.filter((response) => response.status === 429);
      expect(limited.length).toBeGreaterThan(0);
      expect(ProblemDetails.parse(limited[0]!.body).code).toBe('RATE_LIMITED');
      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });
  });

  describe('concurrent voting', () => {
    it('counts one attendee racing themselves exactly once', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => vote(event.joinCode, voter, questionId)),
      );

      // Every request succeeds — none of them is wrong — and every one reports
      // the same final state. The unique index decides who inserted; the row
      // lock makes the rest read the count that insert produced.
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect(results.every((response) => response.body.upvoteCount === 1)).toBe(true);
      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });

    it('counts ten different attendees racing each other as exactly ten', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voters = await Promise.all(Array.from({ length: 10 }, () => join(event.joinCode)));

      const results = await Promise.all(
        voters.map((voter) => vote(event.joinCode, voter, questionId)),
      );

      // This is the test the row lock exists for. Without it, two transactions
      // read "5", both write "6", and the counter is permanently one short of
      // the truth with nothing on any screen to say so.
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect(await countsFor(questionId)).toEqual({ stored: 10, rows: 10 });

      // Each response carried a monotonically consistent count: the last one
      // to commit saw all ten.
      const counts = results.map((response) => response.body.upvoteCount as number);
      expect(Math.max(...counts)).toBe(10);
    });

    it('keeps the counter exact when votes and withdrawals interleave', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voters = await Promise.all(Array.from({ length: 6 }, () => join(event.joinCode)));

      // Three vote first so there is something to withdraw.
      await Promise.all(voters.slice(0, 3).map((voter) => vote(event.joinCode, voter, questionId)));

      await Promise.all([
        ...voters.slice(0, 3).map((voter) => unvote(event.joinCode, voter, questionId)),
        ...voters.slice(3).map((voter) => vote(event.joinCode, voter, questionId)),
      ]);

      expect(await countsFor(questionId)).toEqual({ stored: 3, rows: 3 });
    });
  });

  describe('refresh abuse', () => {
    it('keeps the vote when the page is reloaded and the identity re-joins', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);
      await vote(event.joinCode, voter, questionId).expect(200);

      // A reload calls join again, presenting the cookie it already holds. That
      // must resolve to the SAME attendee, so the vote is still theirs...
      const afterReload = await join(event.joinCode, voter);
      const page = await board(event.joinCode, afterReload).expect(200);
      expect(page.body.items[0]).toMatchObject({ id: questionId, hasVoted: true });

      // ...and voting again from the reloaded page changes nothing.
      await vote(event.joinCode, afterReload, questionId).expect(200);
      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
      expect(await testApp.db.prisma.attendee.count()).toBe(2);
    });

    /**
     * The accepted limit of account-free voting, stated as a test so nobody is
     * surprised by it in production.
     *
     * A device that discards its cookie is, to the server, a new person. There
     * is no way to know otherwise without an account or a browser fingerprint,
     * and fingerprinting is the cross-device tracking this product promises
     * not to do. What contains it: joining is rate limited per IP, and votes
     * enter the ranking as log10(votes + 1), so manufactured support is
     * expensive to produce and worth very little once produced.
     */
    it('KNOWN LIMIT: a device that discards its identity is a new attendee', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);

      const first = await join(event.joinCode);
      await vote(event.joinCode, first, questionId).expect(200);

      const second = await join(event.joinCode); // no cookie presented
      await vote(event.joinCode, second, questionId).expect(200);

      expect(await countsFor(questionId)).toEqual({ stored: 2, rows: 2 });
    });
  });

  describe('multiple devices', () => {
    it('counts two different people on two different devices as two votes', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const phone = await join(event.joinCode);
      const laptop = await join(event.joinCode);

      await vote(event.joinCode, phone, questionId).expect(200);
      const response = await vote(event.joinCode, laptop, questionId).expect(200);

      expect(response.body.upvoteCount).toBe(2);
      expect(await countsFor(questionId)).toEqual({ stored: 2, rows: 2 });
    });

    it('counts one identity presented from two devices as one vote', async () => {
      // The token is the identity, not the connection. Copying a cookie to a
      // second device does not create a second person.
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const token = await join(event.joinCode);

      await vote(event.joinCode, token, questionId).expect(200);
      await testApp
        .http() // a separate agent: separate connection, separate "device"
        .put(`/api/v1/public/events/${event.joinCode}/questions/${questionId}/vote`)
        .set(csrf)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(await countsFor(questionId)).toEqual({ stored: 1, rows: 1 });
    });
  });

  describe('multiple events', () => {
    it('refuses a token from one event on another event’s question', async () => {
      const other = await createPublishedEvent(alice, {
        title: 'Other Night',
        settings: { moderationMode: 'POST' },
      });
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const outsider = await join(other.joinCode);

      // Genuine token, valid signature, wrong event. The URL names our event,
      // so the mismatch is caught by the eventId claim, not by the signature.
      const response = await vote(event.joinCode, outsider, questionId).expect(401);

      expect(ProblemDetails.parse(response.body).code).toBe('UNAUTHENTICATED');
      expect(await countsFor(questionId)).toEqual({ stored: 0, rows: 0 });
    });

    it('cannot reach a question by naming it under a different event’s code', async () => {
      const other = await createPublishedEvent(alice, {
        title: 'Other Night',
        settings: { moderationMode: 'POST' },
      });
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const outsider = await join(other.joinCode);

      // Token and URL agree with each other; only the question is foreign. The
      // repository scopes the row by the token's event, so it simply is not
      // there — and "not there" is all an outsider learns.
      const response = await vote(other.joinCode, outsider, questionId).expect(404);

      expect(ProblemDetails.parse(response.body).code).toBe('NOT_FOUND');
      expect(await countsFor(questionId)).toEqual({ stored: 0, rows: 0 });
    });

    it('gives the same person separate, unlinkable identities at two events', async () => {
      const other = await createPublishedEvent(alice, {
        title: 'Other Night',
        settings: { moderationMode: 'POST' },
      });
      const here = await join(event.joinCode);
      const there = await join(other.joinCode);

      const hereQuestion = await ask(event.joinCode, here, ASKED);
      const thereQuestion = await ask(other.joinCode, there, ASKED);
      await vote(event.joinCode, here, hereQuestion).expect(200);
      await vote(other.joinCode, there, thereQuestion).expect(200);

      const attendees = await testApp.db.prisma.attendee.findMany();
      expect(attendees).toHaveLength(2);
      expect(new Set(attendees.map((attendee) => attendee.eventId)).size).toBe(2);
      // Nothing on either row could join them to the other.
      for (const attendee of attendees) {
        expect(attendee.email).toBeNull();
        expect(attendee.displayName).toBeNull();
      }
    });
  });

  describe('what cannot be voted on', () => {
    it('refuses a vote on a question the room cannot see, as not found', async () => {
      const held = await createPublishedEvent(alice, {
        title: 'Moderated Night',
        settings: { moderationMode: 'PRE' },
      });
      const asker = await join(held.joinCode);
      const questionId = await ask(held.joinCode, asker, ASKED); // PENDING
      const voter = await join(held.joinCode);

      // 404, not 422: a pending question is invisible to the room, and a vote
      // request must not be a way to confirm one exists.
      await vote(held.joinCode, voter, questionId).expect(404);
      expect(await countsFor(questionId)).toEqual({ stored: 0, rows: 0 });
    });

    it('refuses a vote when the organizer switched voting off', async () => {
      const quiet = await createPublishedEvent(alice, {
        title: 'Quiet Night',
        settings: { moderationMode: 'POST', allowUpvotes: false },
      });
      const asker = await join(quiet.joinCode);
      const questionId = await ask(quiet.joinCode, asker, ASKED);
      const voter = await join(quiet.joinCode);

      const response = await vote(quiet.joinCode, voter, questionId).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('VOTING_DISABLED');
    });

    it('tells the board voting is off, so it can hide the buttons', async () => {
      const quiet = await createPublishedEvent(alice, {
        title: 'Quiet Night',
        settings: { allowUpvotes: false },
      });

      const response = await testApp
        .http()
        .post(`/api/v1/public/events/${quiet.joinCode}/attendee`)
        .set(csrf)
        .expect(201);

      expect(response.body.allowUpvotes).toBe(false);
    });

    it('refuses a vote without an attendee token', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);

      await testApp
        .http()
        .put(`/api/v1/public/events/${event.joinCode}/questions/${questionId}/vote`)
        .set(csrf)
        .expect(401);
    });

    it('refuses a vote from a blocked attendee', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      await testApp.db.prisma.attendee.updateMany({
        where: { NOT: { questions: { some: {} } } },
        data: { isBlocked: true, blockedAt: new Date() },
      });

      const response = await vote(event.joinCode, voter, questionId).expect(403);
      expect(ProblemDetails.parse(response.body).code).toBe('ATTENDEE_BLOCKED');
    });

    it('refuses a vote once the event has closed', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);
      const voter = await join(event.joinCode);

      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/close`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      const response = await vote(event.joinCode, voter, questionId).expect(422);
      expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_LIVE');
    });
  });

  describe('the organizer sees the ranking', () => {
    it('orders the moderation queue by votes, with counts to match', async () => {
      const asker = await join(event.joinCode);
      const quiet = await ask(event.joinCode, asker, ASKED);
      const popular = await ask(event.joinCode, asker, 'What metrics matter for networking?');
      const voters = await Promise.all(Array.from({ length: 3 }, () => join(event.joinCode)));

      await Promise.all(voters.map((voter) => vote(event.joinCode, voter, popular)));
      await vote(event.joinCode, voters[0]!, quiet);

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions?status=APPROVED&sort=votes`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([popular, quiet]);
      expect(response.body.items[0].upvoteCount).toBe(3);
      expect(response.body.items[1].upvoteCount).toBe(1);
    });

    it('lets votes lift a question in the default ranked order', async () => {
      const asker = await join(event.joinCode);
      const older = await ask(event.joinCode, asker, ASKED);
      const newer = await ask(event.joinCode, asker, 'What metrics matter for networking?');

      // Newer starts higher on recency alone. The gap between two questions
      // asked seconds apart is tiny, so a single vote should reorder them.
      const voter = await join(event.joinCode);
      await vote(event.joinCode, voter, older);

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions?status=APPROVED&sort=rank`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([older, newer]);
    });

    it('moves the change token, so a polling dashboard is told to refresh', async () => {
      const asker = await join(event.joinCode);
      const questionId = await ask(event.joinCode, asker, ASKED);

      const before = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions/stats`)
        .set('Cookie', alice.cookie)
        .expect(200);

      const voter = await join(event.joinCode);
      await vote(event.joinCode, voter, questionId).expect(200);

      const after = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions/stats`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(after.body.version).not.toBe(before.body.version);
    });
  });
});
