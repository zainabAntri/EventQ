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
 * Duplicate questions: detection, suggestion, and the human decision.
 *
 * The rule under test is simple to state and easy to get wrong: the system
 * may SUGGEST that two questions are the same, and it may never ACT on that
 * suggestion by itself. Every test that flags a pair also checks that both
 * questions still exist afterwards, unchanged, until a moderator says
 * otherwise — including the pair the detector gets wrong.
 */
describe('duplicate questions', () => {
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
      .send({ title: 'AI in Business Breakfast', ...body })
      .expect(201);

    await testApp
      .http()
      .post(`/api/v1/events/${created.body.id}/publish`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .expect(200);

    return created.body;
  }

  async function join(joinCode: string): Promise<string> {
    const response = await testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/attendee`)
      .set(csrf)
      .expect(201);

    const cookies = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const attendeeCookie = cookies.find((entry) => entry.startsWith('eq_pt='));
    if (!attendeeCookie) throw new Error('Join returned no attendee cookie');

    return attendeeCookie.split(';')[0]!.split('=')[1]!;
  }

  async function ask(
    joinCode: string,
    token: string,
    body: string,
  ): Promise<{ id: string; status: string }> {
    const response = await testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/questions`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`)
      .send({ body })
      .expect(201);

    return response.body;
  }

  function vote(joinCode: string, token: string, questionId: string) {
    return testApp
      .http()
      .put(`/api/v1/public/events/${joinCode}/questions/${questionId}/vote`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }

  /** The moderator's view of one question, via the queue it appears in. */
  async function moderatorView(
    owner: RegisteredOrganizer,
    eventId: string,
    questionId: string,
  ): Promise<Record<string, any> | undefined> {
    const response = await testApp
      .http()
      .get(`/api/v1/events/${eventId}/questions`)
      .set('Cookie', owner.cookie)
      .expect(200);

    return response.body.items.find((item: { id: string }) => item.id === questionId);
  }

  function merge(owner: RegisteredOrganizer, questionId: string, intoQuestionId: string) {
    return testApp
      .http()
      .post(`/api/v1/questions/${questionId}/merge`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ intoQuestionId });
  }

  function dismiss(owner: RegisteredOrganizer, questionId: string) {
    return testApp
      .http()
      .post(`/api/v1/questions/${questionId}/dismiss-duplicate`)
      .set(csrf)
      .set('Cookie', owner.cookie);
  }

  const ORIGINAL = 'How can I use AI in my company?';
  const REWORDED = 'How can businesses use AI?';
  const LOOKALIKE = 'How can I use Excel in my company?';
  const UNRELATED = 'What time is lunch served today?';

  // ---------------------------------------------------------------------------

  describe('detecting a duplicate', () => {
    it('suggests that a reworded question repeats an earlier one', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);

      // Different words, same question. Character trigrams alone score this
      // pair at ~0.3; the content-word measure is what catches it.
      const reworded = await ask(event.joinCode, second, REWORDED);

      const view = await moderatorView(alice, event.id, reworded.id);
      expect(view?.flags).toContain('possible_duplicate');
      expect(view?.possibleDuplicate).toMatchObject({
        questionId: original.id,
        body: ORIGINAL,
        status: 'APPROVED',
      });
      expect(view?.possibleDuplicate.similarity).toBeGreaterThanOrEqual(0.6);
      expect(view?.possibleDuplicate.similarity).toBeLessThanOrEqual(1);
    });

    it('still catches a near-verbatim repeat from another attendee', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);

      const repeat = await ask(event.joinCode, second, 'how can i use ai in my company');

      const view = await moderatorView(alice, event.id, repeat.id);
      expect(view?.possibleDuplicate?.questionId).toBe(original.id);
    });

    it('does not suggest anything for an unrelated question', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      await ask(event.joinCode, first, ORIGINAL);

      const unrelated = await ask(event.joinCode, second, UNRELATED);

      const view = await moderatorView(alice, event.id, unrelated.id);
      expect(view?.flags).not.toContain('possible_duplicate');
      expect(view?.possibleDuplicate).toBeNull();
      // And it went straight to the board, as a post-moderated event promises.
      expect(unrelated.status).toBe('APPROVED');
    });

    it('holds a suggested duplicate for a person rather than publishing it', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      await ask(event.joinCode, first, ORIGINAL);

      const reworded = await ask(event.joinCode, second, REWORDED);

      // POST moderation would normally publish immediately. A possible
      // duplicate is the one case where a human looks first — the room does
      // not benefit from seeing the same question twice.
      expect(reworded.status).toBe('PENDING');
    });
  });

  describe('never deleting on a suggestion', () => {
    it('keeps both questions, unchanged, with nothing merged', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      const rows = await testApp.db.prisma.question.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.id)).toEqual([original.id, reworded.id]);
      expect(rows.every((row) => row.deletedAt === null)).toBe(true);
      expect(rows.every((row) => row.mergedIntoQuestionId === null)).toBe(true);
    });

    /**
     * The false positive, kept honest.
     *
     * "AI" and "Excel" are one word apart and word overlap cannot tell the
     * difference, so the detector WILL suggest this pair. What matters is what
     * happens next: nothing. Both questions stay; the copy waits for a person;
     * the person says no; the copy is released as an ordinary question.
     */
    it('FALSE POSITIVE: suggests a lookalike but leaves a human to disagree', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const lookalike = await ask(event.joinCode, second, LOOKALIKE);

      // Suggested — the limitation is real and visible...
      const before = await moderatorView(alice, event.id, lookalike.id);
      expect(before?.possibleDuplicate?.questionId).toBe(original.id);

      // ...and nothing was done about it without a person.
      expect(await testApp.db.prisma.question.count()).toBe(2);

      const dismissed = await dismiss(alice, lookalike.id).expect(200);
      expect(dismissed.body.possibleDuplicate).toBeNull();
      // Dismissing is not approving: the question stays exactly where it was,
      // for the same moderator to approve as an ordinary pending question.
      expect(dismissed.body.status).toBe('PENDING');
      expect(dismissed.body.allowedActions).toContain('approve');

      // Both still here, both intact.
      expect(await testApp.db.prisma.question.count()).toBe(2);
      const trail = await testApp.db.prisma.moderationAction.findMany({
        where: { questionId: lookalike.id, action: 'dismiss_duplicate' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]?.metadata).toMatchObject({ dismissedQuestionId: original.id });
    });

    it('is harmless to dismiss a suggestion twice', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      await dismiss(alice, reworded.id).expect(200);
      const again = await dismiss(alice, reworded.id).expect(200);

      expect(again.body.possibleDuplicate).toBeNull();
      // Only the first click wrote to the trail; the second was a no-op.
      expect(
        await testApp.db.prisma.moderationAction.count({
          where: { questionId: reworded.id, action: 'dismiss_duplicate' },
        }),
      ).toBe(1);
    });
  });

  describe('confirming a duplicate (merge)', () => {
    it('archives the copy, points it at the survivor, and moves its votes', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      // The copy needs to be on the board to attract votes for this test.
      await testApp
        .http()
        .post(`/api/v1/questions/${reworded.id}/moderate`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ action: 'approve' })
        .expect(200);

      const supporters = await Promise.all(Array.from({ length: 3 }, () => join(event.joinCode)));
      for (const supporter of supporters) await vote(event.joinCode, supporter, reworded.id);
      // One of them ALSO voted for the original. They must end up with one
      // vote on the survivor, not two.
      await vote(event.joinCode, supporters[0]!, original.id);

      const response = await merge(alice, reworded.id, original.id).expect(200);

      expect(response.body).toMatchObject({
        id: reworded.id,
        status: 'ARCHIVED',
        mergedIntoQuestionId: original.id,
        possibleDuplicate: null,
      });

      const survivor = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: original.id },
      });
      const survivorVotes = await testApp.db.prisma.questionVote.count({
        where: { questionId: original.id },
      });
      // 3 supporters of the copy + 1 on the original, minus the 1 overlap = 3.
      expect(survivorVotes).toBe(3);
      expect(survivor.upvoteCount).toBe(3);
      expect(survivor.deletedAt).toBeNull();

      const copy = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: reworded.id },
      });
      expect(copy.deletedAt).not.toBeNull();
      expect(copy.mergedIntoQuestionId).toBe(original.id);
    });

    it('counts the copy’s author as an asker and lifts the survivor’s rank', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      const before = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(before.askedByCount).toBe(1);

      await merge(alice, reworded.id, original.id).expect(200);

      const survivor = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: original.id },
      });
      // Nobody voted. The second person's support is that they ASKED, and the
      // survivor's score must reflect it, or five people typing the same thing
      // would rank like one nobody cared about.
      expect(survivor.askedByCount).toBe(2);
      expect(survivor.upvoteCount).toBe(0);
      expect(survivor.rankScore).toBeGreaterThan(before.rankScore);
      expect(survivor.rankScore).toBe(
        computeRankScore({
          upvoteCount: 0,
          askedByCount: 2,
          createdAt: survivor.createdAt,
          status: survivor.status,
          pinnedAt: survivor.pinnedAt,
        }),
      );

      // The count is what the moderator and the room see.
      const item = await moderatorView(alice, event.id, original.id);
      expect(item?.askedByCount).toBe(2);
    });

    it('carries an absorbed count forward when a merged survivor is merged again', async () => {
      const [a, b, c] = await Promise.all([
        join(event.joinCode),
        join(event.joinCode),
        join(event.joinCode),
      ]);
      const original = await ask(event.joinCode, a, ORIGINAL);
      const reworded = await ask(event.joinCode, b, REWORDED);
      const unrelated = await ask(event.joinCode, c, 'Where can I park near the venue?');

      await merge(alice, reworded.id, original.id).expect(200);
      // A moderator decides the parking one belongs with them too. The
      // survivor's count was already 2; it must become 3, not 2.
      await merge(alice, unrelated.id, original.id).expect(200);

      const survivor = await testApp.db.prisma.question.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(survivor.askedByCount).toBe(3);
    });

    it('takes the copy off the attendee board and leaves the survivor', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      await merge(alice, reworded.id, original.id).expect(200);

      const page = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${second}`)
        .expect(200);

      // Even the copy's own author no longer sees it: it is archived, and the
      // survivor now carries their support.
      expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([original.id]);
    });

    it('records the decision on both questions’ audit trails', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      await merge(alice, reworded.id, original.id).expect(200);

      const onCopy = await testApp.db.prisma.moderationAction.findFirst({
        where: { questionId: reworded.id, action: 'merge' },
      });
      const onSurvivor = await testApp.db.prisma.moderationAction.findFirst({
        where: { questionId: original.id, action: 'absorb' },
      });
      expect(onCopy?.actorId).toBe(alice.userId);
      expect(onCopy?.metadata).toMatchObject({ mergedIntoQuestionId: original.id });
      expect(onSurvivor?.metadata).toMatchObject({ mergedFromQuestionId: reworded.id });
    });

    it('re-points other suggestions that named the copy at the survivor', async () => {
      const [first, second, third] = await Promise.all([
        join(event.joinCode),
        join(event.joinCode),
        join(event.joinCode),
      ]);
      const original = await ask(event.joinCode, first!, ORIGINAL);
      const reworded = await ask(event.joinCode, second!, REWORDED);
      // A third question that the system matched to the REWORDED copy.
      const third_ = await ask(event.joinCode, third!, 'how can businesses use ai');

      const before = await moderatorView(alice, event.id, third_.id);
      expect(before?.possibleDuplicate?.questionId).toBe(reworded.id);

      await merge(alice, reworded.id, original.id).expect(200);

      // Otherwise the card for the third question would invite a merge into an
      // archived question, which the server would then refuse.
      const after = await moderatorView(alice, event.id, third_.id);
      expect(after?.possibleDuplicate?.questionId).toBe(original.id);
    });

    it('transfers votes exactly once: the copy cannot be merged again', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);
      const reworded = await ask(event.joinCode, second, REWORDED);

      await merge(alice, reworded.id, original.id).expect(200);
      // Archived is terminal and archived rows are outside every scoped read.
      await merge(alice, reworded.id, original.id).expect(404);

      expect(
        await testApp.db.prisma.moderationAction.count({
          where: { questionId: original.id, action: 'absorb' },
        }),
      ).toBe(1);
    });
  });

  describe('refusing a bad merge', () => {
    it('refuses to merge a question into itself', async () => {
      const first = await join(event.joinCode);
      const original = await ask(event.joinCode, first, ORIGINAL);

      const response = await merge(alice, original.id, original.id).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('CANNOT_MERGE_INTO_SELF');
    });

    it('refuses a chain, which is what makes a cycle impossible', async () => {
      const [first, second, third] = await Promise.all([
        join(event.joinCode),
        join(event.joinCode),
        join(event.joinCode),
      ]);
      const a = await ask(event.joinCode, first!, ORIGINAL);
      const b = await ask(event.joinCode, second!, REWORDED);
      const c = await ask(event.joinCode, third!, UNRELATED);

      await merge(alice, b.id, a.id).expect(200); // b -> a

      // c -> b would make a chain c -> b -> a. Refused: merge into the
      // survivor instead. Since a merged question can never be a target, no
      // chain is ever longer than one link, and a one-link chain cannot loop.
      const response = await merge(alice, c.id, b.id).expect(404);
      expect(ProblemDetails.parse(response.body).code).toBe('NOT_FOUND');
    });

    it('refuses a survivor that is rejected or spam', async () => {
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const a = await ask(event.joinCode, first, ORIGINAL);
      const b = await ask(event.joinCode, second, UNRELATED);

      await testApp
        .http()
        .post(`/api/v1/questions/${a.id}/moderate`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ action: 'reject' })
        .expect(200);

      const response = await merge(alice, b.id, a.id).expect(422);
      expect(ProblemDetails.parse(response.body).code).toBe('INVALID_MERGE_TARGET');
    });

    it('refuses a survivor on a different event', async () => {
      const other = await createPublishedEvent(alice, {
        title: 'Other Breakfast',
        settings: { moderationMode: 'POST' },
      });
      const here = await join(event.joinCode);
      const there = await join(other.joinCode);
      const a = await ask(event.joinCode, here, ORIGINAL);
      const b = await ask(other.joinCode, there, ORIGINAL);

      const response = await merge(alice, b.id, a.id).expect(422);
      expect(ProblemDetails.parse(response.body).code).toBe('INVALID_MERGE_TARGET');
      expect(await testApp.db.prisma.question.count({ where: { deletedAt: null } })).toBe(2);
    });

    it('refuses to touch another organization’s questions, as not found', async () => {
      const mallory = await registerOrganizer(testApp, { email: 'mallory@eventq.test' });
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const a = await ask(event.joinCode, first, ORIGINAL);
      const b = await ask(event.joinCode, second, REWORDED);

      await merge(mallory, b.id, a.id).expect(404);
      await dismiss(mallory, b.id).expect(404);

      const copy = await testApp.db.prisma.question.findUniqueOrThrow({ where: { id: b.id } });
      expect(copy.deletedAt).toBeNull();
      expect(copy.possibleDuplicateOfQuestionId).toBe(a.id);
    });

    it('refuses a moderator without the permission', async () => {
      // A SPEAKER may read the queue but not moderate it.
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);
      const a = await ask(event.joinCode, first, ORIGINAL);
      const b = await ask(event.joinCode, second, REWORDED);

      await testApp.db.prisma.membership.updateMany({
        where: { userId: alice.userId },
        data: { role: 'SPEAKER' },
      });
      // The role travels in the session token, so the demotion takes effect
      // on the next sign-in — which is also true in production.
      const login = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: alice.email, password: alice.password })
        .expect(200);
      const speaker: RegisteredOrganizer = {
        ...alice,
        cookie: (login.headers['set-cookie'] as unknown as string[])
          .map((entry) => entry.split(';')[0])
          .join('; '),
      };

      await merge(speaker, b.id, a.id).expect(403);
      await dismiss(speaker, b.id).expect(403);
    });
  });
});
