import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetails } from '@eventq/contracts';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * Event domain, end to end.
 *
 * The section that matters most is "organizer isolation": every endpoint must
 * refuse to act on another organization's event, and must do so
 * indistinguishably from an event that does not exist.
 */
describe('events', () => {
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

  /** Creates an event owned by the given organizer. */
  async function createEvent(
    owner: RegisteredOrganizer,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string; status: string }> {
    const response = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ title: 'Founders and Funders Night', ...body })
      .expect(201);

    return response.body;
  }

  describe('creation', () => {
    it('creates a draft event with a usable public identifier', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({
          title: 'Founders and Funders Night',
          description: 'An evening of introductions.',
          venue: 'The Barbican, London',
          type: 'NETWORKING',
          timezone: 'Europe/London',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        title: 'Founders and Funders Night',
        venue: 'The Barbican, London',
        // Always starts as a draft. An event must never be publicly reachable
        // the instant it is created.
        status: 'DRAFT',
        organizationId: alice.orgId,
      });
      expect(response.body.joinCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(response.body.publishedAt).toBeNull();
    });

    it('gives each event a distinct join code', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        codes.add((await createEvent(alice, { title: `Event number ${i}` })).joinCode);
      }
      expect(codes.size).toBe(5);
    });

    it('disambiguates slugs within an organization', async () => {
      const first = await createEvent(alice, { title: 'Annual Summit' });
      const second = await createEvent(alice, { title: 'Annual Summit' });

      const [a, b] = await Promise.all(
        [first.id, second.id].map(
          async (id) =>
            (
              await testApp
                .http()
                .get(`/api/v1/events/${id}`)
                .set('Cookie', alice.cookie)
                .expect(200)
            ).body.slug,
        ),
      );

      expect(a).not.toBe(b);
    });

    it('rejects an event whose end precedes its start', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({
          title: 'Time Travelling Summit',
          startsAt: '2026-09-01T18:00:00.000Z',
          endsAt: '2026-09-01T17:00:00.000Z',
        })
        .expect(400);

      expect(ProblemDetails.parse(response.body).errors?.map((e) => e.path)).toContain('endsAt');
    });

    it('rejects a title that is too short and an unknown timezone', async () => {
      await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ title: 'ab' })
        .expect(400);

      await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ title: 'A perfectly fine title', timezone: 'Mars/Olympus_Mons' })
        .expect(400);
    });

    it('ignores client-supplied status, join code and organization (mass assignment)', async () => {
      const bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });

      const response = await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({
          title: 'Sneaky Event',
          // None of these are in the write contract. If any were honoured, a
          // client could self-publish or plant an event in another org.
          status: 'PUBLISHED',
          joinCode: 'HACKED01',
          orgId: bob.orgId,
          organizationId: bob.orgId,
          id: '01930000-0000-7000-8000-0000000000ff',
          publishedAt: new Date().toISOString(),
        })
        .expect(201);

      expect(response.body.status).toBe('DRAFT');
      expect(response.body.joinCode).not.toBe('HACKED01');
      expect(response.body.organizationId).toBe(alice.orgId);
      expect(response.body.id).not.toBe('01930000-0000-7000-8000-0000000000ff');
      expect(response.body.publishedAt).toBeNull();
    });
  });

  describe('organizer isolation (BOLA/IDOR)', () => {
    let bob: RegisteredOrganizer;
    let bobsEvent: { id: string; joinCode: string };

    beforeEach(async () => {
      bob = await registerOrganizer(testApp, { email: 'bob@eventq.test' });
      bobsEvent = await createEvent(bob, { title: 'Bobs Private Retreat' });
    });

    it("does not list another organizer's events", async () => {
      await createEvent(alice, { title: 'Alices Own Event' });

      const response = await testApp
        .http()
        .get('/api/v1/events')
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].title).toBe('Alices Own Event');
    });

    it.each([
      ['read', 'get', ''],
      ['edit', 'patch', ''],
      ['publish', 'post', '/publish'],
      ['unpublish', 'post', '/unpublish'],
      ['close', 'post', '/close'],
      ['delete', 'delete', ''],
    ])(
      "refuses to %s another organizer's event, reporting 404 not 403",
      async (_action, method, suffix) => {
        const path = `/api/v1/events/${bobsEvent.id}${suffix}`;
        const agent = testApp.http();

        const request =
          method === 'get'
            ? agent.get(path)
            : method === 'patch'
              ? agent.patch(path).set(csrf).send({ title: 'Hijacked title' })
              : method === 'delete'
                ? agent.delete(path).set(csrf)
                : agent.post(path).set(csrf);

        const response = await request.set('Cookie', alice.cookie).expect(404);

        // 404, never 403. A 403 would confirm the id is real, letting an
        // attacker enumerate other organizations' events one guess at a time.
        expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_FOUND');
      },
    );

    it("leaves the other organizer's event completely untouched", async () => {
      await testApp
        .http()
        .patch(`/api/v1/events/${bobsEvent.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ title: 'Hijacked title' })
        .expect(404);

      await testApp
        .http()
        .delete(`/api/v1/events/${bobsEvent.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(404);

      // Bob still has his event, with its original title.
      const stillThere = await testApp
        .http()
        .get(`/api/v1/events/${bobsEvent.id}`)
        .set('Cookie', bob.cookie)
        .expect(200);

      expect(stillThere.body.title).toBe('Bobs Private Retreat');
    });

    it("reports a non-existent event identically to another organizer's", async () => {
      const ghost = '01930000-0000-7000-8000-00000000dead';

      const missing = await testApp
        .http()
        .get(`/api/v1/events/${ghost}`)
        .set('Cookie', alice.cookie)
        .expect(404);

      const forbidden = await testApp
        .http()
        .get(`/api/v1/events/${bobsEvent.id}`)
        .set('Cookie', alice.cookie)
        .expect(404);

      // Byte-identical bodies apart from the per-request trace id.
      expect({ ...missing.body, traceId: null, instance: null }).toEqual({
        ...forbidden.body,
        traceId: null,
        instance: null,
      });
    });
  });

  describe('unauthenticated access', () => {
    it('refuses every organizer endpoint without a session', async () => {
      const event = await createEvent(alice);

      await testApp.http().get('/api/v1/events').expect(401);
      await testApp.http().get(`/api/v1/events/${event.id}`).expect(401);
      await testApp
        .http()
        .post('/api/v1/events')
        .set(csrf)
        .send({ title: 'Should not exist' })
        .expect(401);
      await testApp.http().delete(`/api/v1/events/${event.id}`).set(csrf).expect(401);
    });
  });

  describe('lifecycle', () => {
    it('publishes and records when it happened', async () => {
      const event = await createEvent(alice);

      const published = await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(published.body.status).toBe('PUBLISHED');
      expect(published.body.publishedAt).not.toBeNull();
    });

    it('refuses to publish an event twice', async () => {
      const event = await createEvent(alice);
      const publish = () =>
        testApp
          .http()
          .post(`/api/v1/events/${event.id}/publish`)
          .set(csrf)
          .set('Cookie', alice.cookie);

      await publish().expect(200);
      const second = await publish().expect(422);
      expect(second.body.code).toBe('INVALID_EVENT_TRANSITION');
    });

    it('unpublishes an event nobody has joined', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      const unpublished = await testApp
        .http()
        .post(`/api/v1/events/${event.id}/unpublish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(unpublished.body.status).toBe('DRAFT');
    });

    it('refuses to unpublish once someone has participated', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      await testApp.db.prisma.attendee.create({ data: { eventId: event.id } });

      const response = await testApp
        .http()
        .post(`/api/v1/events/${event.id}/unpublish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(409);

      // Withdrawing would hide a real person's contribution.
      expect(response.body.code).toBe('CONFLICT');
      expect(response.body.detail).toContain('Close it instead');
    });

    it('closes an event and then freezes it', async () => {
      const event = await createEvent(alice);
      const owner = { Cookie: alice.cookie };

      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set(owner)
        .expect(200);
      const closed = await testApp
        .http()
        .post(`/api/v1/events/${event.id}/close`)
        .set(csrf)
        .set(owner)
        .expect(200);

      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closedAt).not.toBeNull();

      // A closed event is a record of what happened, so it can no longer be
      // edited or reopened.
      const edit = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set(owner)
        .send({ title: 'Rewriting history' })
        .expect(422);
      expect(edit.body.code).toBe('INVALID_EVENT_TRANSITION');

      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set(owner)
        .expect(422);
    });
  });

  describe('editing', () => {
    it('updates only the fields provided', async () => {
      const event = await createEvent(alice, {
        title: 'Original Title',
        description: 'Original description',
        venue: 'Original venue',
      });

      const updated = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ title: 'Revised Title' })
        .expect(200);

      expect(updated.body.title).toBe('Revised Title');
      // Omitted fields must survive. Treating "absent" as "clear this" is how
      // a partial update quietly destroys data.
      expect(updated.body.description).toBe('Original description');
      expect(updated.body.venue).toBe('Original venue');
    });

    it('clears a field when explicitly sent as null', async () => {
      const event = await createEvent(alice, { venue: 'Somewhere' });

      const updated = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ venue: null })
        .expect(200);

      expect(updated.body.venue).toBeNull();
    });

    it('rejects an empty update', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({})
        .expect(400);
    });

    it('catches a start date pushed past an untouched end date', async () => {
      const event = await createEvent(alice, {
        startsAt: '2026-09-01T09:00:00.000Z',
        endsAt: '2026-09-01T17:00:00.000Z',
      });

      // The payload alone is internally consistent; only the RESULT is invalid,
      // which schema validation on the request body cannot see.
      const response = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ startsAt: '2026-09-02T09:00:00.000Z' })
        .expect(422);

      expect(response.body.errors?.[0]?.path).toBe('endsAt');
    });

    it('updates access configuration', async () => {
      const event = await createEvent(alice);

      const updated = await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ settings: { accessMode: 'PRIVATE', moderationMode: 'POST' } })
        .expect(200);

      expect(updated.body.settings).toMatchObject({
        accessMode: 'PRIVATE',
        moderationMode: 'POST',
      });
    });
  });

  describe('safe deletion', () => {
    it('permanently removes an untouched draft', async () => {
      const event = await createEvent(alice);

      const response = await testApp
        .http()
        .delete(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.body.outcome).toBe('deleted');
      expect(await testApp.db.prisma.event.count({ where: { id: event.id } })).toBe(0);
    });

    it('archives an event that was published, preserving the row', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      const response = await testApp
        .http()
        .delete(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      expect(response.body.outcome).toBe('archived');

      const row = await testApp.db.prisma.event.findUnique({ where: { id: event.id } });
      expect(row?.status).toBe('ARCHIVED');
      expect(row?.deletedAt).not.toBeNull();
    });

    it('never destroys attendee data', async () => {
      const event = await createEvent(alice);
      await testApp.db.prisma.attendee.create({ data: { eventId: event.id } });

      const response = await testApp
        .http()
        .delete(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      // Attendee contributions are not the organizer's to erase from a
      // confirmation dialog.
      expect(response.body.outcome).toBe('archived');
      expect(await testApp.db.prisma.attendee.count({ where: { eventId: event.id } })).toBe(1);
    });

    it('behaves as if a deleted event never existed', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .delete(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      await testApp
        .http()
        .get(`/api/v1/events/${event.id}`)
        .set('Cookie', alice.cookie)
        .expect(404);
    });

    it('hides an archived event from reads and listings', async () => {
      const event = await createEvent(alice);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);
      await testApp
        .http()
        .delete(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      await testApp
        .http()
        .get(`/api/v1/events/${event.id}`)
        .set('Cookie', alice.cookie)
        .expect(404);

      const list = await testApp
        .http()
        .get('/api/v1/events')
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(list.body.items).toHaveLength(0);
    });
  });

  describe('public lookup by join code', () => {
    it('returns a published, public event without authentication', async () => {
      const event = await createEvent(alice, { venue: 'The Barbican' });
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .expect(200);

      const response = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}`)
        .expect(200);

      expect(response.body).toMatchObject({
        title: 'Founders and Funders Night',
        venue: 'The Barbican',
      });

      // The public shape must not carry internal identifiers or configuration.
      expect(response.body).not.toHaveProperty('id');
      expect(response.body).not.toHaveProperty('organizationId');
      expect(response.body).not.toHaveProperty('settings');
      expect(response.body).not.toHaveProperty('publishedAt');
    });

    it('hides an unpublished event', async () => {
      const event = await createEvent(alice);
      const response = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}`)
        .expect(404);
      expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_FOUND');
    });

    it('hides a closed event', async () => {
      const event = await createEvent(alice);
      const owner = { Cookie: alice.cookie };
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set(owner)
        .expect(200);
      await testApp.http().get(`/api/v1/public/events/${event.joinCode}`).expect(200);

      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/close`)
        .set(csrf)
        .set(owner)
        .expect(200);

      await testApp.http().get(`/api/v1/public/events/${event.joinCode}`).expect(404);
    });

    it('hides a published event whose access mode is PRIVATE', async () => {
      const event = await createEvent(alice);
      const owner = { Cookie: alice.cookie };
      await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set(owner)
        .send({ settings: { accessMode: 'PRIVATE' } })
        .expect(200);
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set(owner)
        .expect(200);

      await testApp.http().get(`/api/v1/public/events/${event.joinCode}`).expect(404);
    });

    it('hides an archived event', async () => {
      const event = await createEvent(alice);
      const owner = { Cookie: alice.cookie };
      await testApp
        .http()
        .post(`/api/v1/events/${event.id}/publish`)
        .set(csrf)
        .set(owner)
        .expect(200);
      await testApp.http().delete(`/api/v1/events/${event.id}`).set(csrf).set(owner).expect(200);

      await testApp.http().get(`/api/v1/public/events/${event.joinCode}`).expect(404);
    });

    it('reports an unknown or malformed code identically to a hidden one', async () => {
      const event = await createEvent(alice);

      const hidden = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}`)
        .expect(404);
      const unknown = await testApp.http().get('/api/v1/public/events/ZZZZZZZZ').expect(404);
      const malformed = await testApp.http().get('/api/v1/public/events/not-a-code').expect(404);

      // All identical, so the endpoint cannot be used to discover which codes
      // are real.
      for (const other of [unknown, malformed]) {
        expect(other.body.code).toBe(hidden.body.code);
        expect(other.body.detail).toBe(hidden.body.detail);
      }
    });
  });
});
