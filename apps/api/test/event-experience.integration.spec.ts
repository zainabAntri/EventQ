import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccentColor, ProblemDetails, contrastRatio } from '@eventq/contracts';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * The complete event experience, end to end.
 *
 * Create, publish, print a code, take questions, close — and then the part that
 * did not exist before: what somebody sees when they scan the poster afterwards.
 *
 * The section worth reading first is "closed-event disclosure". It relaxes a
 * deliberate security decision — every hidden state used to produce one
 * indistinguishable 404 — and these tests are what pin down exactly how far
 * that relaxation goes and what it must never widen to.
 */
describe('event experience', () => {
  let testApp: TestApp;
  let alice: RegisteredOrganizer;

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
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createEvent(
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string; joinUrl: string; accentColor: string | null }> {
    const response = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', alice.cookie)
      .send({ title: 'Founders and Funders Night', ...body })
      .expect(201);

    return response.body;
  }

  function publish(eventId: string) {
    return testApp
      .http()
      .post(`/api/v1/events/${eventId}/publish`)
      .set(csrf)
      .set('Cookie', alice.cookie);
  }

  function close(eventId: string) {
    return testApp
      .http()
      .post(`/api/v1/events/${eventId}/close`)
      .set(csrf)
      .set('Cookie', alice.cookie);
  }

  /** Joins as a fresh device; the token is read from Set-Cookie and presented
   *  as Bearer, matching the other attendee suites. */
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

  // ---------------------------------------------------------------------------
  // The organizer's path
  // ---------------------------------------------------------------------------

  describe('the organizer flow', () => {
    it('carries one join code unchanged from draft through to closed', async () => {
      // The whole reason a poster can be printed before publishing: the code an
      // organizer prints on Monday must be the code that works on Thursday.
      const event = await createEvent();
      const draftCode = event.joinCode;

      await publish(event.id).expect(200);
      const published = await testApp
        .http()
        .get(`/api/v1/events/${event.id}`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(published.body.joinCode).toBe(draftCode);

      await close(event.id).expect(200);
      const closed = await testApp
        .http()
        .get(`/api/v1/events/${event.id}`)
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(closed.body.joinCode).toBe(draftCode);
    });

    it('builds the join URL server-side so the poster and the dashboard agree', async () => {
      const event = await createEvent();

      expect(event.joinUrl).toMatch(/\/e\/[0-9A-HJKMNP-TV-Z]{8}$/u);
      expect(event.joinUrl.endsWith(`/e/${event.joinCode}`)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // QR
  // ---------------------------------------------------------------------------

  describe('QR code', () => {
    it('renders SVG by default, encoding the attendee URL', async () => {
      const event = await createEvent();

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/svg+xml');
      // supertest buffers an image response into `body`; `text` is only
      // populated for types it knows how to decode.
      expect(response.body.toString('utf8')).toContain('<svg');
      expect(response.body.toString('utf8')).toContain('viewBox');
      // Never cached by a shared proxy.
      expect(response.headers['cache-control']).toContain('private');
    });

    it('renders PNG on request, for the tools that refuse SVG', async () => {
      const event = await createEvent();

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr?format=png`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      // PNG magic number, so this is a real raster and not an SVG mislabelled.
      expect(response.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    it('falls back to SVG for an unrecognised format rather than erroring', async () => {
      // This is an <img src>. A 400 would render as a broken icon on the
      // dashboard with nothing on screen to explain it.
      const event = await createEvent();

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr?format=tiff`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/svg+xml');
      expect(response.body.toString('utf8')).toContain('<svg');
    });

    it('offers a download with a filename derived from the join code', async () => {
      const event = await createEvent();

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr?format=png&download=1`)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="eventq-${event.joinCode.toLowerCase()}.png"`,
      );
    });

    it('tints the code with the accent at a contrast a scanner can read', async () => {
      // A pale brand colour would otherwise produce a code that looks right on
      // screen and cannot be read by a phone camera in a dim venue.
      const event = await createEvent({ accentColor: '#fde047' });

      const response = await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr`)
        .set('Cookie', alice.cookie)
        .expect(200);

      const svg = response.body.toString('utf8');
      const fills = [...svg.matchAll(/#[0-9a-f]{6}/giu)].map((match) => match[0].toLowerCase());
      const dark = fills.find((colour) => colour !== '#ffffff');

      expect(dark).toBeDefined();
      expect(dark).not.toBe('#fde047');
      expect(contrastRatio(dark!, '#ffffff')).toBeGreaterThanOrEqual(7);
    });

    it("refuses another organizer's event with a 404, not a rendered code", async () => {
      const bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });
      const event = await createEvent();

      await testApp
        .http()
        .get(`/api/v1/events/${event.id}/qr`)
        .set('Cookie', bob.cookie)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Branding
  // ---------------------------------------------------------------------------

  describe('branding', () => {
    it('stores an accent colour and normalises its case', async () => {
      const event = await createEvent({ accentColor: '#7C3AED' });
      expect(event.accentColor).toBe('#7c3aed');
    });

    it('defaults to no accent, so an unbranded event costs nothing', async () => {
      const event = await createEvent();
      expect(event.accentColor).toBeNull();
    });

    it.each(['7c3aed', '#7c3ae', '#7c3aedff', 'rebeccapurple'])(
      'rejects %o as an accent colour',
      async (value) => {
        await testApp
          .http()
          .post('/api/v1/events')
          .set(csrf)
          .set('Cookie', alice.cookie)
          .send({ title: 'Founders and Funders Night', accentColor: value })
          .expect(400);
      },
    );

    it('clears the accent when null is sent, restoring the default', async () => {
      const event = await createEvent({ accentColor: '#7c3aed' });

      const cleared = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ accentColor: null })
        .expect(200);

      expect(cleared.body.accentColor).toBeNull();
    });

    it('reaches the attendee so the scanned page is branded on first paint', async () => {
      const event = await createEvent({ accentColor: '#7c3aed' });
      await publish(event.id).expect(200);

      const response = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}`)
        .expect(200);

      expect(response.body.accentColor).toBe('#7c3aed');
      expect(AccentColor.safeParse(response.body.accentColor).success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // The security decision this phase changed
  // ---------------------------------------------------------------------------

  describe('closed-event disclosure', () => {
    it('serves the closed event and its record to somebody with no session', async () => {
      const event = await createEvent({ settings: { moderationMode: 'POST' } });
      await publish(event.id).expect(200);

      const token = await join(event.joinCode);
      await ask(event.joinCode, token, 'How is the funding round affecting hiring?');
      await close(event.id).expect(200);

      // No cookie, no attendee token, no organizer session: exactly the state
      // of a phone scanning a poster a week later.
      const lookup = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}`)
        .expect(200);
      expect(lookup.body.status).toBe('CLOSED');

      const archive = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive`)
        .expect(200);

      expect(archive.body.items).toHaveLength(1);
      expect(archive.body.items[0].body).toBe('How is the funding round affecting hiring?');
      // Nobody is asking, so nothing is theirs and nothing is voted.
      expect(archive.body.items[0].isMine).toBe(false);
      expect(archive.body.items[0].hasVoted).toBe(false);
    });

    it('never exposes an unmoderated question through the archive', async () => {
      // The archive has no caller, so it cannot have an "except my own" branch.
      // A pending question must be invisible to it even though its author could
      // see it on the live board.
      const event = await createEvent({ settings: { moderationMode: 'PRE' } });
      await publish(event.id).expect(200);

      const token = await join(event.joinCode);
      await ask(event.joinCode, token, 'Is the office moving next year or not?');
      await close(event.id).expect(200);

      const archive = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive`)
        .expect(200);

      expect(archive.body.items).toHaveLength(0);
    });

    it('refuses the archive for a live event, which has its own board', async () => {
      // A second, identity-free way to read a published event's questions would
      // be a way to read them without vote state or the attendee check.
      const event = await createEvent();
      await publish(event.id).expect(200);

      const response = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive`)
        .expect(404);

      expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_FOUND');
    });

    it.each([
      ['a draft', false, false],
      ['a private closed event', true, true],
    ])('refuses the archive for %s', async (_label, shouldPublish, makePrivate) => {
      const event = await createEvent();

      if (shouldPublish) await publish(event.id).expect(200);
      if (makePrivate) {
        await testApp
          .http()
          .patch(`/api/v1/events/${event.id}`)
          .set(csrf)
          .set('Cookie', alice.cookie)
          .send({ settings: { accessMode: 'PRIVATE' } })
          .expect(200);
        await close(event.id).expect(200);
      }

      await testApp.http().get(`/api/v1/public/events/${event.joinCode}/archive`).expect(404);
    });

    it('answers an unknown code identically to a refused one', async () => {
      const event = await createEvent();

      const draft = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive`)
        .expect(404);
      const unknown = await testApp
        .http()
        .get('/api/v1/public/events/ZZZZZZZZ/archive')
        .expect(404);

      expect(unknown.body.code).toBe(draft.body.code);
      expect(unknown.body.detail).toBe(draft.body.detail);
    });

    it('refuses to mint an attendee identity for a closed event', async () => {
      // Readable does not mean joinable. Creating an attendee row — and the
      // retention clock attached to it — for somebody who can no longer take
      // part would be collecting data for nothing.
      const event = await createEvent();
      await publish(event.id).expect(200);
      await close(event.id).expect(200);

      await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/attendee`)
        .set(csrf)
        .expect(404);

      expect(await testApp.db.prisma.attendee.count()).toBe(0);
    });

    it('refuses a new question from a token minted before the event closed', async () => {
      // The attendee is real and their token is valid; the event is simply no
      // longer taking questions. Visible must never imply writable.
      const event = await createEvent({ settings: { moderationMode: 'POST' } });
      await publish(event.id).expect(200);
      const token = await join(event.joinCode);
      await close(event.id).expect(200);

      await testApp
        .http()
        .post(`/api/v1/public/events/${event.joinCode}/questions`)
        .set(csrf)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Can I still ask something after the end?' })
        .expect(422);
    });

    it('ranks the archive by support rather than recency', async () => {
      // What a late visitor wants from a finished event is what the room cared
      // about most, not whatever happened to be typed last.
      const event = await createEvent({ settings: { moderationMode: 'POST' } });
      await publish(event.id).expect(200);

      const asker = await join(event.joinCode);
      const popular = await ask(event.joinCode, asker, 'What happens to the London office lease?');
      await ask(event.joinCode, asker, 'Will there be sandwiches at the next one?');

      // Three other devices back the first question.
      for (let index = 0; index < 3; index += 1) {
        const voter = await join(event.joinCode);
        await testApp
          .http()
          .put(`/api/v1/public/events/${event.joinCode}/questions/${popular}/vote`)
          .set(csrf)
          .set('Authorization', `Bearer ${voter}`)
          .expect(200);
      }

      await close(event.id).expect(200);

      const archive = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive`)
        .expect(200);

      expect(archive.body.items[0].id).toBe(popular);
      expect(archive.body.items[0].upvoteCount).toBe(3);
    });

    it('paginates the archive without repeating or skipping a question', async () => {
      const event = await createEvent({ settings: { moderationMode: 'POST' } });
      await publish(event.id).expect(200);
      const token = await join(event.joinCode);

      // Deliberately unrelated to one another: five variations on one sentence
      // would trip duplicate detection and only the first would reach the
      // board, which would make this a test of nothing.
      const questions = [
        'What happens to the London office lease next year?',
        'Is the graduate scheme opening again this autumn?',
        'How will the merger change our reporting lines?',
        'Are we keeping the four-day week after the trial?',
        'When does the new expenses system go live?',
      ];
      for (const body of questions) {
        await ask(event.joinCode, token, body);
      }
      await close(event.id).expect(200);

      const first = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/archive?limit=2`)
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const second = await testApp
        .http()
        .get(
          `/api/v1/public/events/${event.joinCode}/archive?limit=2&cursor=${encodeURIComponent(
            first.body.nextCursor,
          )}`,
        )
        .expect(200);

      const seen = [...first.body.items, ...second.body.items].map(
        (item: { id: string }) => item.id,
      );
      expect(new Set(seen).size).toBe(seen.length);
    });
  });
});
