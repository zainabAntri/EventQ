import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetails } from '@eventq/contracts';
import {
  AiProviderFailure,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
} from '../src/modules/ai/domain/ai-provider.port';
import { RedisService } from '../src/shared/redis/redis.service';
import {
  csrf,
  registerOrganizer,
  startTestApp,
  type RegisteredOrganizer,
  type TestApp,
} from './app.harness';

/**
 * AI enrichment, end to end — against a real database and a FAKE model.
 *
 * The provider is scripted per test. That is the only honest way to test
 * this surface: a real model costs money on every run and answers differently
 * on every run, and what these tests are about is not what the model says but
 * what EventQ does with it — and what it refuses to do. Two questions run
 * through everything below:
 *
 *   - Is every result a SUGGESTION? Nothing here may change a status, publish
 *     an answer or reach the attendee board.
 *   - Does the core product keep working while the provider is broken?
 */

/** The fake: answers or failures queued by the test, every call recorded. */
class ScriptedProvider implements AiProvider {
  calls: AiCompletionRequest<unknown>[] = [];
  private script: Array<unknown | AiProviderFailure | (() => never)> = [];

  reply(output: unknown): this {
    this.script.push(output);
    return this;
  }

  fail(kind: AiProviderFailure['kind'], retryable = false): this {
    this.script.push(new AiProviderFailure(kind, retryable, `scripted ${kind}`));
    return this;
  }

  reset(): void {
    this.calls = [];
    this.script = [];
  }

  async complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletion<T>> {
    this.calls.push(request);
    const next = this.script.shift();
    if (next === undefined) throw new AiProviderFailure('unavailable', false, 'nothing scripted');
    if (next instanceof AiProviderFailure) throw next;

    // The real adapter validates against the schema; the fake must too, or a
    // test could hand a use-case a shape the runner would never let through.
    const parsed = request.schema.safeParse(next);
    if (!parsed.success)
      throw new AiProviderFailure('invalid_response', false, 'scripted malformed');

    return {
      output: parsed.data,
      modelId: request.modelId,
      usage: { inputTokens: 500, outputTokens: 80, cachedReadTokens: 0 },
    };
  }
}

describe('AI enrichment', () => {
  let testApp: TestApp;
  let alice: RegisteredOrganizer;
  let event: { id: string; joinCode: string };
  const provider = new ScriptedProvider();

  beforeAll(async () => {
    testApp = await startTestApp({ aiProvider: provider });
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  beforeEach(async () => {
    await testApp.db.truncate();
    await testApp.resetRateLimits();
    await clearAiKeys();
    provider.reset();
    alice = await registerOrganizer(testApp, { email: 'alice@eventq.test' });
    event = await createPublishedEvent(alice, {
      settings: { moderationMode: 'POST', aiEnabled: true },
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function clearAiKeys(): Promise<void> {
    try {
      const client = testApp.app.get(RedisService).client;
      const keys = await client.keys('eventq:ai:*');
      if (keys.length > 0) await client.del(...keys);
    } catch {
      /* Redis absent: the coordination layer fails open, nothing to clear. */
    }
  }

  async function createPublishedEvent(
    owner: RegisteredOrganizer,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; joinCode: string }> {
    const created = await testApp
      .http()
      .post('/api/v1/events')
      .set(csrf)
      .set('Cookie', owner.cookie)
      .send({ title: 'AI in Business Breakfast', description: 'Founders and investors.', ...body })
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
    return cookies
      .find((c) => c.startsWith('eq_pt='))!
      .split(';')[0]!
      .split('=')[1]!;
  }

  async function ask(
    joinCode: string,
    body: string,
    displayName?: string,
  ): Promise<{ id: string; status: string }> {
    const token = await join(joinCode);
    const response = await testApp
      .http()
      .post(`/api/v1/public/events/${joinCode}/questions`)
      .set(csrf)
      .set('Authorization', `Bearer ${token}`)
      .send({ body, ...(displayName ? { displayName } : {}) })
      .expect(201);
    return response.body;
  }

  /** Three unrelated questions, so the deterministic detector flags nothing. */
  async function askThree(): Promise<string[]> {
    const bodies = [
      'How can I use AI in my company?',
      'What time is lunch served today?',
      'Should we hire a data scientist first?',
    ];
    const ids: string[] = [];
    for (const body of bodies) ids.push((await ask(event.joinCode, body)).id);
    return ids;
  }

  function post(path: string, owner: RegisteredOrganizer = alice) {
    return testApp.http().post(`/api/v1${path}`).set(csrf).set('Cookie', owner.cookie);
  }

  function get(path: string, owner: RegisteredOrganizer = alice) {
    return testApp.http().get(`/api/v1${path}`).set('Cookie', owner.cookie);
  }

  async function moderatorView(questionId: string): Promise<Record<string, any>> {
    const response = await get(`/events/${event.id}/questions`).expect(200);
    return response.body.items.find((item: { id: string }) => item.id === questionId);
  }

  // ---------------------------------------------------------------------------

  describe('the switches', () => {
    it('reports status before any button is offered', async () => {
      const response = await get(`/events/${event.id}/ai/status`).expect(200);

      expect(response.body).toMatchObject({
        availableOnServer: true,
        enabledForEvent: true,
        eventSpendMicros: 0,
        eventBudgetMicros: 2_000_000,
        monthlySpendMicros: 0,
      });
      expect(response.body.models.CLASSIFICATION).toBe('claude-haiku-4-5');
      expect(response.body.models.SUMMARIZATION).toBe('claude-sonnet-5');
    });

    it('refuses every feature when the organizer has AI off for the event', async () => {
      const quiet = await createPublishedEvent(alice, {
        title: 'Quiet',
        settings: { aiEnabled: false },
      });
      const { id: questionId } = await ask(quiet.joinCode, 'How can I use AI in my company?');
      provider.reply({ assignments: [] });

      for (const path of [
        `/events/${quiet.id}/ai/categorize`,
        `/events/${quiet.id}/ai/cluster`,
        `/events/${quiet.id}/ai/summary`,
        `/questions/${questionId}/ai/similar`,
        `/questions/${questionId}/ai/suggest-answer`,
      ]) {
        const response = await post(path).expect(422);
        expect(ProblemDetails.parse(response.body).code).toBe('AI_DISABLED');
      }

      // Refused BEFORE the provider, and nothing on the ledger.
      expect(provider.calls).toHaveLength(0);
      expect(await testApp.db.prisma.aiUsage.count()).toBe(0);
    });

    it('is off by default for a new event', async () => {
      const fresh = await createPublishedEvent(alice, { title: 'Fresh' });
      const response = await get(`/events/${fresh.id}/ai/status`).expect(200);

      expect(response.body.enabledForEvent).toBe(false);
    });

    it('lets the organizer switch it on and off per event', async () => {
      await testApp
        .http()
        .patch(`/api/v1/events/${event.id}`)
        .set(csrf)
        .set('Cookie', alice.cookie)
        .send({ settings: { aiEnabled: false } })
        .expect(200);

      const response = await get(`/events/${event.id}/ai/status`).expect(200);
      expect(response.body.enabledForEvent).toBe(false);
    });
  });

  describe('1. categorisation', () => {
    it('stores a category for each question, from the fixed set only', async () => {
      const [ai, lunch, hiring] = await askThree();
      provider.reply({
        assignments: [
          { question: 1, category: 'AI' },
          { question: 2, category: 'Catering' }, // not in the set
          { question: 3, category: 'Business' },
        ],
      });

      const response = await post(`/events/${event.id}/ai/categorize`).expect(200);

      expect(response.body).toMatchObject({ categorized: 2, rejected: 1, remaining: 1 });
      expect((await moderatorView(ai!)).category).toBe('AI');
      expect((await moderatorView(hiring!)).category).toBe('Business');
      expect((await moderatorView(lunch!)).category).toBeNull();

      // Provenance on the row: which model, which prompt version.
      const enrichment = await testApp.db.prisma.questionEnrichment.findUniqueOrThrow({
        where: { questionId: ai! },
      });
      expect(enrichment.modelId).toBe('claude-haiku-4-5');
      expect(enrichment.promptVersion).toBeTruthy();
      expect(enrichment.status).toBe('COMPLETED');
    });

    it('changes nothing else about the question', async () => {
      const [id] = await askThree();
      const before = await moderatorView(id!);
      provider.reply({ assignments: [{ question: 1, category: 'Technology' }] });

      await post(`/events/${event.id}/ai/categorize`).expect(200);

      const after = await moderatorView(id!);
      expect(after.status).toBe(before.status);
      expect(after.upvoteCount).toBe(before.upvoteCount);
      expect(after.body).toBe(before.body);
    });

    it('sends nothing but the question text and the event text to the model', async () => {
      await ask(event.joinCode, 'How can I use AI in my company?', 'Priya Raman');
      provider.reply({ assignments: [] });

      await post(`/events/${event.id}/ai/categorize`).expect(200);

      const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.input}`;
      expect(sent).toContain('How can I use AI in my company?');
      expect(sent).toContain('AI in Business Breakfast');
      expect(sent).not.toContain('Priya');
      expect(sent).not.toContain('alice@eventq.test');
      expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // no UUIDs
    });

    it('makes no call at all when there is nothing to categorise', async () => {
      const response = await post(`/events/${event.id}/ai/categorize`).expect(200);

      expect(response.body).toEqual({ categorized: 0, rejected: 0, remaining: 0, usage: null });
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('2. similar-question detection', () => {
    it('writes the match as the same suggestion the deterministic detector uses', async () => {
      const [ai, lunch, hiring] = await askThree();
      provider.reply({ match: 2, confidence: 0.9, reason: 'Both ask about hiring.' });

      const response = await post(`/questions/${ai}/ai/similar`).expect(200);

      // The model saw the two OTHER questions in trigram order and named the
      // second; whichever that was, the suggestion must be one of them and
      // never the question itself.
      const suggested = response.body.suggestion.questionId as string;
      expect([lunch, hiring]).toContain(suggested);
      expect(suggested).not.toBe(ai);

      const view = await moderatorView(ai!);
      expect(view.possibleDuplicate.questionId).toBe(suggested);
      expect(view.possibleDuplicate.similarity).toBe(0.9);
      // Suggested, not merged: both questions still stand.
      expect(await testApp.db.prisma.question.count({ where: { deletedAt: null } })).toBe(3);
      expect(view.status).toBe('APPROVED');
    });

    it('writes nothing when the model says none match, or is not confident', async () => {
      const [ai] = await askThree();
      provider.reply({ match: 1, confidence: 0.3, reason: 'Loosely related.' });

      const response = await post(`/questions/${ai}/ai/similar`).expect(200);

      expect(response.body.suggestion).toBeNull();
      expect((await moderatorView(ai!)).possibleDuplicate).toBeNull();
    });

    it('never overwrites a suggestion the moderator already dismissed', async () => {
      const [ai, lunch, hiring] = await askThree();
      // A dismissed suggestion leaves the column null with an audit row; the AI
      // path is allowed to fill a null. What it must not do is REPLACE one
      // that stands. Set one by hand and confirm it survives.
      await testApp.db.prisma.question.update({
        where: { id: ai! },
        data: { possibleDuplicateOfQuestionId: lunch!, duplicateSimilarity: 0.61 },
      });
      provider.reply({ match: 1, confidence: 0.99, reason: 'x' });

      await post(`/questions/${ai}/ai/similar`).expect(200);

      const row = await testApp.db.prisma.question.findUniqueOrThrow({ where: { id: ai! } });
      expect(row.possibleDuplicateOfQuestionId).toBe(lunch);
      expect(row.possibleDuplicateOfQuestionId).not.toBe(hiring);
    });
  });

  describe('3. clustering', () => {
    it('stores topics and points questions at them', async () => {
      const [ai, lunch, hiring] = await askThree();
      const fourth = (await ask(event.joinCode, 'Which AI tools are worth paying for?')).id;
      provider.reply({
        topics: [
          { label: 'AI adoption', summary: 'How to start with AI.', questions: [1, 4] },
          { label: 'Hiring', summary: '', questions: [3] }, // one question: dropped
          { label: 'Ghosts', summary: '', questions: [40, 41] }, // invented: dropped
        ],
      });

      const response = await post(`/events/${event.id}/ai/cluster`).expect(200);

      expect(response.body.topics).toHaveLength(1);
      expect(response.body.topics[0]).toMatchObject({ label: 'AI adoption', questionCount: 2 });
      expect(response.body.topics[0].questionIds).toEqual(expect.arrayContaining([ai, fourth]));
      expect(response.body.unclustered).toBe(2);

      expect((await moderatorView(ai!)).topic).toMatchObject({ label: 'AI adoption' });
      expect((await moderatorView(lunch!)).topic).toBeNull();
      expect((await moderatorView(hiring!)).topic).toBeNull();

      const listed = await get(`/events/${event.id}/ai/topics`).expect(200);
      expect(listed.body).toHaveLength(1);
    });

    it('replaces the previous topics rather than piling up', async () => {
      await askThree();
      provider.reply({ topics: [{ label: 'First', summary: '', questions: [1, 2] }] });
      await post(`/events/${event.id}/ai/cluster`).expect(200);

      // The event must CHANGE between runs. An unchanged event re-clustered is
      // a cache hit — same questions, same answer, no charge — which is what
      // the runner is for; this test is about what a genuinely new run does.
      await ask(event.joinCode, 'Which AI tools are worth paying for?');
      provider.reply({ topics: [{ label: 'Second', summary: '', questions: [2, 3] }] });
      await post(`/events/${event.id}/ai/cluster`).expect(200);

      const topics = await testApp.db.prisma.topic.findMany({ where: { eventId: event.id } });
      expect(topics.map((topic) => topic.label)).toEqual(['Second']);
    });
  });

  describe('4. suggested answer', () => {
    it('stores a DRAFT the organizer can see and the room cannot', async () => {
      const [ai] = await askThree();
      provider.reply({
        draft: 'Start with one narrow, measurable process.',
        caveats: ['I do not know your industry.'],
      });

      const response = await post(`/questions/${ai}/ai/suggest-answer`).expect(200);

      expect(response.body).toMatchObject({
        questionId: ai,
        draft: 'Start with one narrow, measurable process.',
        caveats: ['I do not know your industry.'],
        modelId: 'claude-sonnet-5',
      });

      // On the moderator's card, labelled as what it is.
      const view = await moderatorView(ai!);
      expect(view.aiSuggestedAnswer).toMatchObject({
        draft: 'Start with one narrow, measurable process.',
        modelId: 'claude-sonnet-5',
      });

      // NOT an answer: no Answer row, status unchanged, nothing on the board.
      expect(await testApp.db.prisma.answer.count()).toBe(0);
      expect(view.status).toBe('APPROVED');
      const token = await join(event.joinCode);
      const board = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(JSON.stringify(board.body)).not.toContain('narrow, measurable');
      expect(JSON.stringify(board.body)).not.toContain('aiSuggestedAnswer');
    });
  });

  describe('5. event summary', () => {
    const SUMMARY = {
      headline: 'The room wanted practical AI advice.',
      themes: [{ title: 'AI', description: 'Getting started.', questions: [1] }],
      notableQuestions: [{ question: 3, why: 'Hiring is the real blocker.' }],
      suggestedFollowUps: ['Share a starter checklist.'],
    };

    it('stores a LIVE summary while the event runs, with validated references', async () => {
      const [ai, , hiring] = await askThree();
      provider.reply({
        ...SUMMARY,
        notableQuestions: [...SUMMARY.notableQuestions, { question: 99, why: 'x' }],
      });

      const response = await post(`/events/${event.id}/ai/summary`).expect(200);

      expect(response.body).toMatchObject({
        kind: 'LIVE',
        headline: 'The room wanted practical AI advice.',
        questionCount: 3,
        modelId: 'claude-sonnet-5',
      });
      expect(response.body.themes[0].questionIds).toEqual([ai]);
      expect(response.body.notableQuestions).toEqual([
        { questionId: hiring, status: 'APPROVED', why: 'Hiring is the real blocker.' },
      ]);

      const latest = await get(`/events/${event.id}/ai/summary`).expect(200);
      expect(latest.body.summary.id).toBe(response.body.id);
    });

    it('stores a FINAL summary once the event has closed', async () => {
      await askThree();
      await post(`/events/${event.id}/close`).expect(200);
      provider.reply(SUMMARY);

      const response = await post(`/events/${event.id}/ai/summary`).expect(200);
      expect(response.body.kind).toBe('FINAL');
    });

    it('reports null when no summary exists yet', async () => {
      const response = await get(`/events/${event.id}/ai/summary`).expect(200);
      expect(response.body).toEqual({ summary: null });
    });
  });

  describe('cost control', () => {
    it('records every call on the ledger with its real cost', async () => {
      await askThree();
      provider.reply({ assignments: [{ question: 1, category: 'AI' }] });

      await post(`/events/${event.id}/ai/categorize`).expect(200);

      const rows = await testApp.db.prisma.aiUsage.findMany({ where: { eventId: event.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        feature: 'CLASSIFICATION',
        modelId: 'claude-haiku-4-5',
        tokensIn: 500,
        tokensOut: 80,
      });
      // 500 in + 80 out on Haiku = 500 + 400 µ$.
      expect(rows[0]!.costMicros).toBe(900);

      const status = await get(`/events/${event.id}/ai/status`).expect(200);
      expect(status.body.eventSpendMicros).toBe(900);
      expect(status.body.callsByFeature.CLASSIFICATION).toBe(1);
    });

    it('refuses once the event budget is spent, before calling the provider', async () => {
      await askThree();
      // Spend the whole cap by hand on the ledger.
      await testApp.db.prisma.aiUsage.create({
        data: { eventId: event.id, feature: 'SUMMARIZATION', modelId: 'x', costMicros: 2_000_000 },
      });
      provider.reply({ assignments: [] });

      const response = await post(`/events/${event.id}/ai/categorize`).expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('AI_BUDGET_EXCEEDED');
      expect(provider.calls).toHaveLength(0);
    });

    it('serves a repeat of the same request from the cache at no cost', async () => {
      await askThree();
      provider.reply({ draft: 'A draft.', caveats: [] });
      const [id] = await testApp.db.prisma.question
        .findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } })
        .then((rows) => rows.map((row) => row.id));

      await post(`/questions/${id}/ai/suggest-answer`).expect(200);
      const second = await post(`/questions/${id}/ai/suggest-answer`).expect(200);

      expect(second.body.usage).toMatchObject({ cached: true, costMicros: 0 });
      expect(provider.calls).toHaveLength(1);
      expect(await testApp.db.prisma.aiUsage.count()).toBe(1);
    });
  });

  describe('provider failures', () => {
    it('reports a timeout cleanly, changes nothing, and does not retry', async () => {
      const [id] = await askThree();
      provider.fail('timeout');

      const response = await post(`/questions/${id}/ai/suggest-answer`).expect(503);

      expect(ProblemDetails.parse(response.body).code).toBe('AI_PROVIDER_ERROR');
      expect(response.body.detail).not.toContain('scripted');
      expect(provider.calls).toHaveLength(1);
      expect((await moderatorView(id!)).aiSuggestedAnswer).toBeNull();
    });

    it('retries a rate limit exactly once, then reports it', async () => {
      await askThree();
      provider.fail('rate_limited', true).fail('rate_limited', true);

      const response = await post(`/events/${event.id}/ai/categorize`).expect(503);

      expect(ProblemDetails.parse(response.body).code).toBe('AI_PROVIDER_ERROR');
      expect(provider.calls).toHaveLength(2);
    });

    it('discards a malformed reply rather than storing it', async () => {
      const [id] = await askThree();
      provider.reply({ completely: 'wrong' });

      await post(`/questions/${id}/ai/suggest-answer`).expect(503);

      expect(await testApp.db.prisma.questionEnrichment.count()).toBe(0);
    });

    it('reports an unavailable model as a configuration problem', async () => {
      await askThree();
      provider.fail('model_not_found');

      const response = await post(`/events/${event.id}/ai/cluster`).expect(503);
      expect(response.body.detail).toMatch(/configuration/i);
    });

    it('keeps the whole attendee flow working while the provider is down', async () => {
      // The requirement in one test: with the model throwing on every call,
      // an attendee can still join, ask, be listed and vote, and a moderator
      // can still approve — because none of those paths can reach the model.
      provider.fail('unavailable', true).fail('unavailable', true);
      await post(`/events/${event.id}/ai/summary`).expect(503);

      const { id } = await ask(event.joinCode, 'Does anything still work?');
      const token = await join(event.joinCode);
      await testApp
        .http()
        .put(`/api/v1/public/events/${event.joinCode}/questions/${id}/vote`)
        .set(csrf)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await post(`/questions/${id}/moderate`).send({ action: 'answer' }).expect(200);

      const board = await testApp
        .http()
        .get(`/api/v1/public/events/${event.joinCode}/questions`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(board.body.items.map((item: { id: string }) => item.id)).toContain(id);
    });
  });

  describe('access', () => {
    it('refuses another organization, as not found', async () => {
      const mallory = await registerOrganizer(testApp, { email: 'mallory@eventq.test' });
      const [id] = await askThree();
      provider.reply({ assignments: [] });

      await post(`/events/${event.id}/ai/categorize`, mallory).expect(404);
      await post(`/questions/${id}/ai/suggest-answer`, mallory).expect(404);
      await get(`/events/${event.id}/ai/status`, mallory).expect(404);
      expect(provider.calls).toHaveLength(0);
    });

    it('refuses a role without ai:run', async () => {
      await testApp.db.prisma.membership.updateMany({
        where: { userId: alice.userId },
        data: { role: 'SPEAKER' },
      });
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

      await post(`/events/${event.id}/ai/categorize`, speaker).expect(403);
      // Reading status is fine: a speaker may see what AI has done.
      await get(`/events/${event.id}/ai/status`, speaker).expect(200);
    });
  });
});
