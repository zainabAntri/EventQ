import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CategoryBreakdownResponse, EventInsightsResponse } from '@eventq/contracts';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * Event Insights, end to end against a real Postgres.
 *
 * Every number is driven through the public API the way a real event would
 * produce it — attendees join, ask and vote; a moderator approves, answers
 * and merges — and then checked against what actually happened. The counts
 * are the product's claim about an event; a wrong one is a wrong claim made
 * to an organizer about their own audience.
 */
describe('event insights', () => {
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

  async function createPublishedEvent(
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string }> {
    const created = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', alice.cookie)
      .send({ title: 'AI in Business Breakfast', ...body })
      .expect(201);

    await testApp
      .http()
      .post(`/api/v1/events/${created.body.id}/publish`)
      .set(csrf)
      .set('Cookie', alice.cookie)
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
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }

  function moderate(questionId: string, action: string) {
    return testApp
      .http()
      .post(`/api/v1/questions/${questionId}/moderate`)
      .set(csrf)
      .set('Cookie', alice.cookie)
      .send({ action })
      .expect(200);
  }

  async function insights(eventId: string): Promise<EventInsightsResponse> {
    const response = await testApp
      .http()
      .get(`/api/v1/events/${eventId}/insights`)
      .set('Cookie', alice.cookie)
      .expect(200);

    // Parsed with the shared contract, so a field the dashboard relies on
    // cannot go missing without this test noticing.
    return EventInsightsResponse.parse(response.body);
  }

  // Worded so the duplicate detector leaves them alone — duplicates have
  // their own test below.
  const AI_START = 'How should small businesses start using AI tools?';
  const AI_SUPPORT = 'Which AI tools help most with customer support?';
  const PRICING = 'Is the workshop recording going to be shared afterwards?';

  // ---------------------------------------------------------------------------

  it('reports what actually happened at an event', async () => {
    const event = await createPublishedEvent(); // pre-moderation by default
    const [ana, ben, cai] = [
      await join(event.joinCode),
      await join(event.joinCode),
      await join(event.joinCode),
    ];

    const q1 = await ask(event.joinCode, ana, AI_START);
    const q2 = await ask(event.joinCode, ana, PRICING);
    const q3 = await ask(event.joinCode, ben, AI_SUPPORT);

    await moderate(q1, 'approve');
    await moderate(q3, 'approve');
    await moderate(q2, 'reject');

    await vote(event.joinCode, cai, q1);
    await vote(event.joinCode, cai, q3);
    await vote(event.joinCode, ana, q3);

    await moderate(q1, 'answer');

    const result = await insights(event.id);

    expect(result.questions).toMatchObject({
      submitted: 3,
      unanswered: 1,
      answerRate: 0.5,
      mergedAsDuplicate: 0,
    });
    expect(result.questions.byStatus).toMatchObject({
      ANSWERED: 1,
      APPROVED: 1,
      REJECTED: 1,
      PENDING: 0,
      SPAM: 0,
    });

    // Ana asked and voted, Ben only asked, Cai only voted: three people.
    expect(result.engagement).toEqual({ votes: 3, askers: 2, voters: 2, participants: 3 });

    expect(result.highlights.mostUpvoted).toMatchObject({ id: q3, upvoteCount: 2 });
    // The follow-up list is approved-and-unanswered only: not the answered
    // one, and never the rejected one.
    expect(result.highlights.unanswered.map((question) => question.id)).toEqual([q3]);
    // No duplicates were merged, so nobody "asked the most".
    expect(result.highlights.mostAsked).toBeNull();

    expect(result.moderation).toMatchObject({ mode: 'PRE', moderatorApproved: 2 });
    expect(result.moderation.medianWaitSeconds).not.toBeNull();
    expect(result.moderation.medianWaitSeconds).toBeGreaterThanOrEqual(0);

    const timelineTotal = result.timeline.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(timelineTotal).toBe(3);

    // Counted over live questions only: the rejected one is not a theme.
    expect(result.frequentTerms.analysed).toBe(2);
    expect(result.frequentTerms.truncated).toBe(false);
    expect(result.frequentTerms.terms).toEqual(
      expect.arrayContaining([
        { term: 'ai', questions: 2, share: 1 },
        { term: 'tools', questions: 2, share: 1 },
      ]),
    );
  });

  it('reports duplicate groups only once a person has confirmed the merge', async () => {
    const event = await createPublishedEvent({ settings: { moderationMode: 'POST' } });
    const original = await ask(
      event.joinCode,
      await join(event.joinCode),
      'How can I use AI in my company?',
    );
    const copy = await ask(
      event.joinCode,
      await join(event.joinCode),
      'How can businesses use AI?',
    );

    // Suggested, not confirmed: awaiting review, not yet a group.
    let result = await insights(event.id);
    expect(result.duplicates).toMatchObject({ groups: 0, awaitingReview: 1 });

    await testApp
      .http()
      .post(`/api/v1/questions/${copy}/merge`)
      .set(csrf)
      .set('Cookie', alice.cookie)
      .send({ intoQuestionId: original })
      .expect(200);

    result = await insights(event.id);
    expect(result.duplicates).toMatchObject({ groups: 1, awaitingReview: 0 });
    expect(result.duplicates.largest[0]).toMatchObject({ id: original, askedByCount: 2 });
    expect(result.highlights.mostAsked).toMatchObject({ id: original, askedByCount: 2 });

    // The merged copy was still submitted — consolidated, not discarded.
    expect(result.questions.submitted).toBe(2);
    expect(result.questions.mergedAsDuplicate).toBe(1);

    // Post-moderation approves on submit, so there was no wait to measure.
    expect(result.moderation).toEqual({
      mode: 'POST',
      moderatorApproved: 0,
      medianWaitSeconds: null,
    });
  });

  it('reports an empty event honestly rather than as a failure', async () => {
    const event = await createPublishedEvent();
    const result = await insights(event.id);

    expect(result.questions.submitted).toBe(0);
    // Nothing approved is not "0% answered".
    expect(result.questions.answerRate).toBeNull();
    expect(result.timeline.buckets).toEqual([]);
    expect(result.frequentTerms.terms).toEqual([]);
  });

  it('contains measured facts only — no AI-derived field exists in the response', async () => {
    const event = await createPublishedEvent();
    await ask(event.joinCode, await join(event.joinCode), AI_START);

    const response = await testApp
      .http()
      .get(`/api/v1/events/${event.id}/insights`)
      .set('Cookie', alice.cookie)
      .expect(200);

    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/"(category|categories|topic|topics|summary|modelId)"/);
    // Nor does it identify anyone.
    expect(text).not.toMatch(/"(attendeeId|authorName|displayName)"/);
  });

  it('refuses another organization with the same 404 as a missing event', async () => {
    const event = await createPublishedEvent();
    const mallory = await registerOrganizer(testApp, { email: 'mallory@eventq.test' });

    await testApp
      .http()
      .get(`/api/v1/events/${event.id}/insights`)
      .set('Cookie', mallory.cookie)
      .expect(404);

    await testApp.http().get(`/api/v1/events/${event.id}/insights`).expect(401);
  });

  it('serves the stored AI category breakdown without AI being switched on', async () => {
    // A READ of earlier runs: it calls no model, so it must work — and report
    // nothing categorised — on an event where AI has never been enabled.
    const event = await createPublishedEvent({ settings: { moderationMode: 'POST' } });
    await ask(event.joinCode, await join(event.joinCode), AI_START);

    const response = await testApp
      .http()
      .get(`/api/v1/events/${event.id}/ai/categories`)
      .set('Cookie', alice.cookie)
      .expect(200);

    expect(CategoryBreakdownResponse.parse(response.body)).toEqual({
      categories: [],
      categorized: 0,
      uncategorized: 1,
      modelIds: [],
      lastCategorizedAt: null,
    });
  });
});
