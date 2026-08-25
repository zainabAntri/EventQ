import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetails, QUESTION_BODY_HARD_MAX } from '@eventq/contracts';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * Attendee question submission, end to end.
 *
 * The public endpoint is the hostile surface in this product: no account, no
 * session anyone chose to create, and a URL printed on a poster in a room full
 * of strangers. Most of what follows is therefore about what it REFUSES, and
 * about the cases where refusing must not reveal anything.
 */
describe('attendee questions', () => {
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
    event = await createPublishedEvent(alice);
  });

  async function createEvent(
    owner: RegisteredOrganizer,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string }> {
    const response = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ title: 'Founders and Funders Night', ...body })
      .expect(201);

    return response.body;
  }

  async function publish(owner: RegisteredOrganizer, eventId: string): Promise<void> {
    await testApp
      .http()
      .post(`/api/v1/events/${eventId}/publish`)
      .set(csrf)
      .set('Cookie', owner.cookie)
      .expect(200);
  }

  async function createPublishedEvent(
    owner: RegisteredOrganizer,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string }> {
    const created = await createEvent(owner, body);
    await publish(owner, created.id);
    return created;
  }

  /**
   * Joins and returns the token.
   *
   * The token is read out of Set-Cookie rather than a response body, because it
   * is never in the body — that is the point of an httpOnly cookie. Tests then
   * present it as a Bearer token, which the guard also accepts for non-browser
   * clients, so the path-scoped cookie does not have to be simulated.
   */
  async function join(joinCode: string): Promise<{ token: string; body: Record<string, unknown> }> {
    const response = await testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/attendee`)
      .set(csrf)
      .expect(201);

    const cookies = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const attendeeCookie = cookies.find((entry) => entry.startsWith('eq_pt='));
    if (!attendeeCookie) throw new Error('Join returned no attendee cookie');

    return {
      token: attendeeCookie.split(';')[0]!.split('=')[1]!,
      body: response.body,
    };
  }

  function submit(joinCode: string, token: string, body: Record<string, unknown>) {
    return testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/questions`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  const VALID = 'How do you follow up after meeting someone at an event like this?';

  // ---------------------------------------------------------------------------

  describe('joining', () => {
    it('mints an identity with no account and no personal data', async () => {
      const { body } = await join(event.joinCode);

      expect(body).toMatchObject({
        identityMode: 'OPTIONAL',
        moderationMode: 'PRE',
        limits: { minQuestionLength: 10, maxQuestionLength: 500 },
      });
      // Nothing that could identify a person is asked for or returned.
      expect(body.displayName).toBeNull();
      expect(JSON.stringify(body)).not.toContain('email');
    });

    it('sets the token as an httpOnly cookie rather than returning it', async () => {
      const response = await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/attendee`)
        .set(csrf)
        .expect(201);

      const cookie = (response.headers['set-cookie'] as unknown as string[])[0]!;

      // httpOnly is what stops an injected script reading the token and
      // replaying someone else's identity.
      expect(cookie).toMatch(/HttpOnly/i);
      // Scoped to THIS event's routes, so one device can hold separate
      // identities at two concurrent events without them colliding.
      expect(cookie).toContain(`Path=/api/v1/public/events/${event.joinCode}`);
      expect(JSON.stringify(response.body)).not.toContain('eyJ');
    });

    it('reuses the identity a device already holds rather than minting a second', async () => {
      // Otherwise a page refresh would produce a fresh attendee with a fresh
      // submission quota, which defeats per-attendee rate limiting entirely.
      const first = await join(event.joinCode);

      const second = await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/attendee`)
        .set(csrf)
        .set('Authorization', `Bearer ${first.token}`)
        .expect(201);

      expect(second.body.attendeeId).toBe(first.body.attendeeId);
      expect(await testApp.db.prisma.attendee.count()).toBe(1);
    });
  });

  describe('submitting a valid question', () => {
    it('accepts it and holds it for moderation on a pre-moderated event', async () => {
      const { token } = await join(event.joinCode);

      const response = await submit(event.joinCode, token, { body: VALID }).expect(201);

      expect(response.body).toMatchObject({
        body: VALID,
        status: 'PENDING',
        isMine: true,
        upvoteCount: 0,
      });
    });

    it('publishes immediately when the organizer chose post-moderation', async () => {
      const open = await createPublishedEvent(alice, {
        title: 'Open Mic Night',
        settings: { moderationMode: 'POST' },
      });
      const { token } = await join(open.joinCode);

      const response = await submit(open.joinCode, token, { body: VALID }).expect(201);

      expect(response.body.status).toBe('APPROVED');
    });

    it('records an optional name, and omits it when the attendee stays anonymous', async () => {
      const { token } = await join(event.joinCode);

      const named = await submit(event.joinCode, token, {
        body: VALID,
        displayName: 'Priya Raman',
      }).expect(201);
      expect(named.body).toMatchObject({ authorName: 'Priya Raman', isAnonymous: false });

      const hidden = await submit(event.joinCode, token, {
        body: 'What metrics actually matter when measuring networking?',
        isAnonymous: true,
      }).expect(201);
      expect(hidden.body).toMatchObject({ authorName: null, isAnonymous: true });
    });

    it('ignores a client-supplied status (mass assignment)', async () => {
      const { token } = await join(event.joinCode);

      const response = await submit(event.joinCode, token, {
        body: VALID,
        // None of these are in the write contract. If any were honoured, an
        // attendee could publish straight past moderation.
        status: 'APPROVED',
        upvoteCount: 9_999,
        eventId: '01930000-0000-7000-8000-0000000000ff',
      }).expect(201);

      expect(response.body.status).toBe('PENDING');
      expect(response.body.upvoteCount).toBe(0);
    });
  });

  describe('validation', () => {
    it('refuses an empty question', async () => {
      const { token } = await join(event.joinCode);

      const response = await submit(event.joinCode, token, { body: '' }).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('QUESTION_TOO_SHORT');
    });

    it('refuses a whitespace-only question with the SAME code as an empty one', async () => {
      // One situation, one code. A client should not have to handle two.
      const { token } = await join(event.joinCode);

      const response = await submit(event.joinCode, token, {
        body: '   \n\n\t   ',
      }).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('QUESTION_TOO_SHORT');
    });

    it('refuses a question below the event minimum', async () => {
      const { token } = await join(event.joinCode);

      await submit(event.joinCode, token, { body: 'too short' }).expect(422);
    });

    it('refuses a question above the event maximum', async () => {
      const { token } = await join(event.joinCode);

      const response = await submit(event.joinCode, token, {
        body: 'a'.repeat(501),
      }).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('QUESTION_TOO_LONG');
    });

    it('rejects an extremely long payload at the schema before any work is done', async () => {
      const { token } = await join(event.joinCode);

      // Past the hard ceiling: a cheap 400 rather than normalising, hashing and
      // comparing a megabyte of text first.
      const response = await submit(event.joinCode, token, {
        body: 'a'.repeat(QUESTION_BODY_HARD_MAX + 1),
      }).expect(400);

      expect(ProblemDetails.parse(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('cannot be tricked into accepting a short question padded with invisible characters', async () => {
      const { token } = await join(event.joinCode);
      const zeroWidth = String.fromCodePoint(0x200b);

      // Looks long to String.length, is three characters to a person.
      await submit(event.joinCode, token, {
        body: `hi${zeroWidth.repeat(300)}!`,
      }).expect(422);
    });
  });

  describe('injection', () => {
    it('stores HTML verbatim rather than mangling it', async () => {
      // XSS is prevented by escaping at RENDER time, not by corrupting input.
      // A question about HTML is a legitimate question.
      const { token } = await join(event.joinCode);
      const html = 'Is <b>bold</b> markup allowed in questions here?';

      const response = await submit(event.joinCode, token, { body: html }).expect(201);

      expect(response.body.body).toBe(html);
    });

    it('stores a script tag verbatim and never executes or strips it', async () => {
      const { token } = await join(event.joinCode);
      const script = '<script>alert("xss")</script> what does that do?';

      const response = await submit(event.joinCode, token, { body: script }).expect(201);

      expect(response.body.body).toBe(script);
      const stored = await testApp.db.prisma.question.findFirstOrThrow();
      expect(stored.body).toBe(script);
    });

    it('is unaffected by SQL metacharacters', async () => {
      const { token } = await join(event.joinCode);
      const sqlish = "'; DROP TABLE questions; -- how do I escape quotes?";

      await submit(event.joinCode, token, { body: sqlish }).expect(201);

      // The table is still there and holds exactly the one question.
      expect(await testApp.db.prisma.question.count()).toBe(1);
    });

    it('quarantines a javascript: URL instead of publishing it', async () => {
      const open = await createPublishedEvent(alice, {
        title: 'Open Mic',
        settings: { moderationMode: 'POST' },
      });
      const { token } = await join(open.joinCode);

      const response = await submit(open.joinCode, token, {
        body: 'Great talk, see javascript:alert(document.cookie) for more info',
      }).expect(201);

      // Reported to its author as PENDING, never as SPAM: confirming a hit
      // would let a spammer tune against the filter until they got past it.
      expect(response.body.status).toBe('PENDING');

      const stored = await testApp.db.prisma.question.findFirstOrThrow();
      expect(stored.status).toBe('SPAM');
    });
  });

  describe('duplicate and retry protection', () => {
    it('refuses the same question asked twice', async () => {
      const { token } = await join(event.joinCode);

      await submit(event.joinCode, token, { body: VALID }).expect(201);
      const response = await submit(event.joinCode, token, { body: VALID }).expect(409);

      expect(ProblemDetails.parse(response.body).code).toBe('DUPLICATE_QUESTION');
    });

    it('sees through punctuation and casing when detecting a repeat', async () => {
      const { token } = await join(event.joinCode);

      await submit(event.joinCode, token, { body: VALID }).expect(201);
      await submit(event.joinCode, token, { body: `  ${VALID.toUpperCase()}!!  ` }).expect(409);
    });

    it('lets two different attendees ask the same thing', async () => {
      // Independent people converging on one question is normal, and merging is
      // a moderation decision rather than a reason to refuse someone.
      const first = await join(event.joinCode);
      const second = await join(event.joinCode);

      await submit(event.joinCode, first.token, { body: VALID }).expect(201);
      await submit(event.joinCode, second.token, { body: VALID }).expect(201);

      expect(await testApp.db.prisma.question.count()).toBe(2);
    });

    it('returns the original question when a request is retried with the same key', async () => {
      const { token } = await join(event.joinCode);
      const key = 'retry-key-abc123';

      const first = await submit(event.joinCode, token, { body: VALID })
        .set('Idempotency-Key', key)
        .expect(201);

      const retry = await submit(event.joinCode, token, { body: VALID })
        .set('Idempotency-Key', key)
        .expect(201);

      // Same question, not a second one and not a 409 — a dropped response on
      // venue wifi must be safely resendable.
      expect(retry.body.id).toBe(first.body.id);
      expect(await testApp.db.prisma.question.count()).toBe(1);
    });

    it('survives identical submissions racing each other', async () => {
      const { token } = await join(event.joinCode);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(event.joinCode, token, { body: VALID })),
      );

      // Exactly one wins. The unique index is what settles this — an
      // application-level check alone would let two through.
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await testApp.db.prisma.question.count()).toBe(1);
    });

    it('never returns a 500 when a race is lost', async () => {
      const { token } = await join(event.joinCode);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(event.joinCode, token, { body: VALID })),
      );

      // A unique-constraint violation surfacing raw would be a 500 with a
      // Prisma stack trace. It must be a clean, documented 409.
      expect(results.every((r) => r.status < 500)).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('stops one attendee flooding the board', async () => {
      const { token } = await join(event.joinCode);

      // The default allowance is 5 per minute per attendee. Bodies differ so
      // the duplicate check is not what refuses them.
      for (let n = 0; n < 5; n += 1) {
        await submit(event.joinCode, token, {
          body: `Question number ${n} about building a professional network`,
        }).expect(201);
      }

      const blocked = await submit(event.joinCode, token, {
        body: 'One question too many about building a professional network',
      }).expect(429);

      expect(ProblemDetails.parse(blocked.body).code).toBe('SUBMISSION_LIMIT_REACHED');
      expect(blocked.headers['retry-after']).toBeDefined();
      // A limiter that refuses AFTER doing the work protects nothing.
      expect(await testApp.db.prisma.question.count()).toBe(5);
    });
  });

  describe('event status', () => {
    it('refuses questions once the event is closed', async () => {
      const { token } = await join(event.joinCode);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/close`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      const response = await submit(event.joinCode, token, { body: VALID }).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_LIVE');
    });

    it('cannot be joined while the event is still a draft', async () => {
      const draft = await createEvent(alice, { title: 'Unpublished Retreat' });

      await testApp
        .http()
        .post(`/api/v1/public/events/${draft.joinCode}/attendee`)
        .set(csrf)
        .expect(404);
    });

    it('cannot be joined when the organizer made the event private', async () => {
      const priv = await createPublishedEvent(alice, {
        title: 'Board Meeting',
        settings: { accessMode: 'PRIVATE' },
      });

      // 404, not 403: a 403 would confirm the join code is real and turn the
      // endpoint into a probe for valid codes.
      await testApp
        .http()
        .post(`/api/v1/public/events/${priv.joinCode}/attendee`)
        .set(csrf)
        .expect(404);
    });

    it('reports an unknown code and a malformed one identically', async () => {
      // Distinguishing them would leak the code FORMAT, narrowing a guessing
      // attack against a 2^40 space considerably.
      const unknown = await testApp
        .http()
        .post('/api/v1/public/events/ZZZZZZZZ/attendee')
        .set(csrf)
        .expect(404);

      const malformed = await testApp
        .http()
        .post('/api/v1/public/events/not-a-code/attendee')
        .set(csrf)
        .expect(404);

      expect(ProblemDetails.parse(unknown.body).code).toBe(
        ProblemDetails.parse(malformed.body).code,
      );
    });
  });

  describe('attendee isolation', () => {
    it('refuses a submission with no attendee token', async () => {
      await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/questions`)
        .set(csrf)
        .send({ body: VALID })
        .expect(401);
    });

    it('refuses a token minted for a different event', async () => {
      // A perfectly valid signature is not enough: it is a token for somewhere
      // else, and the eventId claim is checked against the URL.
      const other = await createPublishedEvent(alice, { title: 'A Different Event' });
      const { token } = await join(other.joinCode);

      await submit(event.joinCode, token, { body: VALID }).expect(401);
    });

    it('refuses a forged token', async () => {
      await submit(event.joinCode, 'not.a.real.token', { body: VALID }).expect(401);
    });

    it('blocks a state-changing request that omits the CSRF header', async () => {
      const { token } = await join(event.joinCode);

      await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: VALID })
        .expect(403);
    });

    it("shows an attendee their own pending question but never another's", async () => {
      const mine = await join(event.joinCode);
      const theirs = await join(event.joinCode);

      await submit(event.joinCode, mine.token, { body: VALID }).expect(201);
      await submit(event.joinCode, theirs.token, {
        body: 'What is the best way to run a panel discussion?',
      }).expect(201);

      const board = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(200);

      // Both are PENDING, so only the caller's own appears.
      expect(board.body.items).toHaveLength(1);
      expect(board.body.items[0]).toMatchObject({ body: VALID, isMine: true });
    });

    it('never exposes an attendee id or another attendee-identifying field', async () => {
      const { token } = await join(event.joinCode);
      await submit(event.joinCode, token, { body: VALID }).expect(201);

      const board = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const serialised = JSON.stringify(board.body);
      expect(serialised).not.toContain('attendeeId');
      expect(serialised).not.toContain('normalizedBody');
      expect(serialised).not.toContain('bodyHash');
    });
  });

  describe('moderation', () => {
    async function submitOne(): Promise<string> {
      const { token } = await join(event.joinCode);
      const response = await submit(event.joinCode, token, { body: VALID }).expect(201);
      return response.body.id;
    }

    function moderate(questionId: string, action: string, owner = alice) {
      return testApp
        .http()
        .post(`/api/v1/questions/${questionId}/moderate`)
        .set(csrf)
        .set('Cookie', owner.cookie)
        .send({ action });
    }

    it('lists pending questions for the organizer with the reason they were held', async () => {
      const { token } = await join(event.joinCode);
      await submit(event.joinCode, token, {
        body: 'Great talk, see javascript:alert(1) for more information',
      }).expect(201);

      const queue = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions?status=SPAM`)
        .set('Cookie', alice.cookie)
        .expect(200);

      // A moderator DOES see SPAM as SPAM, and is told why — a queue that hides
      // its reasoning is one nobody can act on with confidence.
      expect(queue.body.items[0].status).toBe('SPAM');
      expect(queue.body.items[0].flags).toContain('disallowed_url_scheme');
    });

    it('approves a pending question', async () => {
      const id = await submitOne();

      const response = await moderate(id, 'approve').expect(200);

      expect(response.body.status).toBe('APPROVED');
    });

    it('refuses a transition that is not legal from the current state', async () => {
      const id = await submitOne();

      // A pending question has not been approved, so it cannot jump straight to
      // answered. Skipping moderation by naming a later state is exactly what
      // the state machine exists to prevent.
      const response = await moderate(id, 'answer').expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('INVALID_QUESTION_TRANSITION');

      // And it really did not move.
      const stored = await testApp.db.prisma.question.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe('PENDING');
    });

    it('treats an archived question as gone rather than as unmoderatable', async () => {
      const id = await submitOne();
      await moderate(id, 'archive').expect(200);

      // 404, not 422. ARCHIVED is the soft-delete state, so it disappears from
      // every scoped read — the same convention the events module uses for an
      // archived event. Nothing may leave ARCHIVED anyway, so the two responses
      // permit exactly the same thing; this one is consistent with the rest of
      // the codebase.
      await moderate(id, 'approve').expect(404);

      const stored = await testApp.db.prisma.question.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe('ARCHIVED');
      expect(stored.deletedAt).not.toBeNull();
    });

    it('refuses an action that is not one of the known actions', async () => {
      const id = await submitOne();

      // The API takes an intent from a fixed set, never a target status, so
      // this cannot express "put it in APPROVED" at all.
      await moderate(id, 'APPROVED').expect(400);
      await moderate(id, 'delete_everything').expect(400);
    });

    it('records an immutable audit row for every decision', async () => {
      const id = await submitOne();
      await moderate(id, 'approve').expect(200);

      const actions = await testApp.db.prisma.moderationAction.findMany({
        where: { questionId: id, actorType: 'USER' },
      });

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: 'approve', actorId: alice.userId });
    });

    it("refuses to moderate another organization's question", async () => {
      const bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });
      const id = await submitOne();

      // 404, identical to a question that does not exist. A 403 would confirm
      // the id is real and let an attacker enumerate other organizations.
      await moderate(id, 'approve', bob).expect(404);
    });

    it("does not list another organization's questions", async () => {
      const bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });
      await submitOne();

      const queue = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/questions`)
        .set('Cookie', bob.cookie)
        .expect(200);

      expect(queue.body.items).toHaveLength(0);
    });

    it('makes an approved question visible to every attendee', async () => {
      const id = await submitOne();
      await moderate(id, 'approve').expect(200);

      const someoneElse = await join(event.joinCode);
      const board = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${someoneElse.token}`)
        .expect(200);

      expect(board.body.items).toHaveLength(1);
      expect(board.body.items[0]).toMatchObject({ status: 'APPROVED', isMine: false });
    });
  });
});
