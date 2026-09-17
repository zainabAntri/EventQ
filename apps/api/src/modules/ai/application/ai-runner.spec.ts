import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfigService } from '../../../shared/config/app-config.service';
import {
  AiProviderFailure,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
} from '../domain/ai-provider.port';
import type {
  AiCoordination,
  AiEventContext,
  AiRepository,
  UsageEntry,
} from '../domain/ai.repository';
import { AI_LIMITS } from '../domain/ai-limits';
import {
  AiBudgetExceededError,
  AiBusyError,
  AiDisabledError,
  AiUnavailableError,
} from '../domain/ai.errors';
import { AiRunner } from './ai-runner';

/**
 * The runner, driven through every failure the requirements name.
 *
 * Nothing here touches a network, a database or Redis. The provider is a
 * scripted fake; the ledger, cache and lock are maps. That is what makes it
 * possible to assert the things that matter about money and safety:
 * exactly how many times the provider was called, exactly what the ledger
 * says afterwards, and that a failing provider never leaks anything but a
 * clean domain error.
 */

const Output = z.object({ answer: z.string() });

const EVENT: AiEventContext = {
  eventId: '01930000-0000-7000-8000-0000000000e1',
  orgId: '01930000-0000-7000-8000-0000000000a1',
  title: 'Test Event',
  description: null,
  status: 'PUBLISHED',
  aiEnabled: true,
};

/** A provider whose next answers are queued up by the test. */
class FakeProvider implements AiProvider {
  calls: AiCompletionRequest<unknown>[] = [];
  private script: Array<(() => AiCompletion<unknown>) | AiProviderFailure> = [];

  succeed(output: unknown, usage = { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0 }) {
    this.script.push(() => ({ output, usage, modelId: 'claude-haiku-4-5' }));
    return this;
  }

  fail(kind: AiProviderFailure['kind'], retryable: boolean) {
    this.script.push(new AiProviderFailure(kind, retryable, `scripted ${kind}`));
    return this;
  }

  async complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletion<T>> {
    this.calls.push(request);
    const next = this.script.shift();
    if (!next) throw new Error('FakeProvider: no scripted response left');
    if (next instanceof AiProviderFailure) throw next;
    return next() as AiCompletion<T>;
  }
}

/** Just enough of the repository: the ledger, in memory. */
class FakeRepository {
  ledger = new Map<string, UsageEntry>();
  private nextId = 0;

  recordUsage = vi.fn(async (entry: UsageEntry) => {
    const id = `usage-${(this.nextId += 1)}`;
    this.ledger.set(id, entry);
    return { id };
  });

  correctUsage = vi.fn(async (id: string, actual: Omit<UsageEntry, 'eventId' | 'feature'>) => {
    const existing = this.ledger.get(id)!;
    this.ledger.set(id, { ...existing, ...actual });
  });

  sumCostForEvent = vi.fn(async (eventId: string) =>
    [...this.ledger.values()]
      .filter((entry) => entry.eventId === eventId)
      .reduce((sum, entry) => sum + entry.costMicros, 0),
  );

  sumCostSince = vi.fn(async () =>
    [...this.ledger.values()].reduce((sum, entry) => sum + entry.costMicros, 0),
  );

  totalCost(): number {
    return [...this.ledger.values()].reduce((sum, entry) => sum + entry.costMicros, 0);
  }
}

class FakeCoordination implements AiCoordination {
  locks = new Set<string>();
  cache = new Map<string, string>();

  async acquireLock(key: string): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }
  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }
  async getCached(key: string): Promise<string | null> {
    return this.cache.get(key) ?? null;
  }
  async setCached(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
  }
}

function configWith(
  overrides: Partial<{
    enabled: boolean;
    eventBudgetMicros: number;
    monthlyBudgetMicros: number;
  }> = {},
) {
  return {
    ai: {
      enabled: true,
      apiKey: 'test',
      models: {
        classify: 'claude-haiku-4-5',
        dedup: 'claude-haiku-4-5',
        insight: 'claude-sonnet-5',
      },
      eventBudgetMicros: 2_000_000,
      monthlyBudgetMicros: 50_000_000,
      ...overrides,
    },
  } as unknown as AppConfigService;
}

let provider: FakeProvider;
let repository: FakeRepository;
let coordination: FakeCoordination;

function runner(config = configWith()): AiRunner {
  return new AiRunner(config, provider, repository as unknown as AiRepository, coordination);
}

function request() {
  return {
    event: EVENT,
    feature: 'CLASSIFICATION' as const,
    system: 'You classify things.',
    input: '1. How can I use AI in my company?',
    schema: Output,
  };
}

beforeEach(() => {
  provider = new FakeProvider();
  repository = new FakeRepository();
  coordination = new FakeCoordination();
  // The retry delay is real time in the runner; the tests do not want to wait.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

describe('the switches', () => {
  it('refuses before touching anything when AI is off at the server', async () => {
    provider.succeed({ answer: 'x' });

    await expect(runner(configWith({ enabled: false })).run(request())).rejects.toBeInstanceOf(
      AiDisabledError,
    );

    expect(provider.calls).toHaveLength(0);
    expect(repository.recordUsage).not.toHaveBeenCalled();
  });

  it('refuses when the organizer has not switched AI on for the event', async () => {
    provider.succeed({ answer: 'x' });

    await expect(
      runner().run({ ...request(), event: { ...EVENT, aiEnabled: false } }),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });

    expect(provider.calls).toHaveLength(0);
  });
});

describe('a successful call', () => {
  it('returns the validated output and the actual cost', async () => {
    provider.succeed(
      { answer: 'AI' },
      { inputTokens: 1_000, outputTokens: 200, cachedReadTokens: 0 },
    );

    const result = await runner().run(request());

    expect(result.output).toEqual({ answer: 'AI' });
    expect(result.usage).toEqual({
      modelId: 'claude-haiku-4-5',
      inputTokens: 1_000,
      outputTokens: 200,
      costMicros: 2_000,
      cached: false,
    });
  });

  it('writes the ledger BEFORE dispatch at the worst case, then corrects it', async () => {
    provider.succeed({ answer: 'AI' }, { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0 });

    await runner().run(request());

    // Written first, at the worst case: full output allowance, nothing cached.
    const recorded = repository.recordUsage.mock.calls[0]![0];
    expect(recorded.tokensOut).toBe(AI_LIMITS.maxOutputTokens.CLASSIFICATION);
    expect(recorded.costMicros).toBeGreaterThan(200);
    expect(repository.recordUsage).toHaveBeenCalledBefore(repository.correctUsage);

    // Then corrected to what the provider actually reported.
    expect(repository.totalCost()).toBe(200); // 100 in + 20 out on Haiku
  });

  it('releases the lock afterwards', async () => {
    provider.succeed({ answer: 'x' });
    await runner().run(request());

    expect(coordination.locks.size).toBe(0);
  });
});

describe('excessive cost', () => {
  it('refuses a call whose worst case would cross the event budget, and calls nothing', async () => {
    provider.succeed({ answer: 'x' });

    await expect(
      runner(configWith({ eventBudgetMicros: 1 })).run(request()),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);

    expect(provider.calls).toHaveLength(0);
    // Nothing was written to the ledger for a call that was never made.
    expect(repository.recordUsage).not.toHaveBeenCalled();
  });

  it('refuses against the monthly cap independently of the event cap', async () => {
    provider.succeed({ answer: 'x' });

    await expect(
      runner(configWith({ monthlyBudgetMicros: 1 })).run(request()),
    ).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED', context: { scope: 'month' } });
  });

  it('counts prior spend: the call that would cross the line is the one refused', async () => {
    provider.succeed({ answer: 'x' }).succeed({ answer: 'y' });
    // The worst case of one CLASSIFICATION call on Haiku is ~10,015 µ$ (2,000
    // output tokens at $5/M plus a few input tokens). A cap just above that
    // admits the first call; once its real 200 µ$ is on the ledger, the
    // second call's worst case no longer fits.
    const run = runner(configWith({ eventBudgetMicros: 10_100 }));

    await run.run(request());
    await expect(
      run.run({ ...request(), input: 'different, so no cache hit' }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);

    expect(provider.calls).toHaveLength(1);
  });
});

describe('the cache', () => {
  it('serves a repeat of the same prompt without calling the provider or the ledger', async () => {
    provider.succeed({ answer: 'AI' });
    const run = runner();

    const first = await run.run(request());
    const second = await run.run(request());

    expect(second.output).toEqual(first.output);
    expect(second.usage).toMatchObject({ cached: true, costMicros: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(repository.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('misses when the input differs, even slightly', async () => {
    provider.succeed({ answer: 'a' }).succeed({ answer: 'b' });
    const run = runner();

    await run.run(request());
    await run.run({ ...request(), input: `${request().input} ` });

    expect(provider.calls).toHaveLength(2);
  });

  it('ignores a cached entry that no longer matches the schema', async () => {
    provider.succeed({ answer: 'fresh' });
    // Something an older shape wrote under the same key.
    const run = runner();
    coordination.cache.set([...coordination.cache.keys()][0] ?? 'never', 'x');
    // Seed with the real key by running once, then corrupt it.
    await run.run(request());
    for (const key of coordination.cache.keys()) coordination.cache.set(key, '{"wrong":"shape"}');
    provider.succeed({ answer: 'fresh again' });

    const result = await run.run(request());

    expect(result.output).toEqual({ answer: 'fresh again' });
    expect(result.usage.cached).toBe(false);
  });
});

describe('concurrency', () => {
  it('refuses a second identical action while the first holds the lock', async () => {
    coordination.locks.add(`ai:lock:${EVENT.eventId}:CLASSIFICATION`);
    provider.succeed({ answer: 'x' });

    await expect(runner().run(request())).rejects.toBeInstanceOf(AiBusyError);
    expect(provider.calls).toHaveLength(0);
  });

  it('locks per feature, so a summary can run while categorisation runs', async () => {
    coordination.locks.add(`ai:lock:${EVENT.eventId}:CLASSIFICATION`);
    provider.succeed({ answer: 'x' });

    await expect(runner().run({ ...request(), feature: 'SUMMARIZATION' })).resolves.toBeTruthy();
  });
});

describe('provider failures', () => {
  it('retries ONCE on a rate limit, then succeeds', async () => {
    provider.fail('rate_limited', true).succeed({ answer: 'ok' });

    const result = await runner().run(request());

    expect(result.output).toEqual({ answer: 'ok' });
    expect(provider.calls).toHaveLength(2);
  });

  it('retries once on an overloaded provider and then gives up cleanly', async () => {
    provider.fail('unavailable', true).fail('unavailable', true).succeed({ answer: 'never' });

    await expect(runner().run(request())).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      status: 503,
    });

    // The bound: two attempts, never a third. This is the whole of the
    // "never enter an uncontrolled retry loop" guarantee.
    expect(provider.calls).toHaveLength(AI_LIMITS.maxAttempts);
    expect(provider.calls).toHaveLength(2);
  });

  it('does NOT retry a timeout, because the first attempt may already be billed', async () => {
    provider.fail('timeout', false).succeed({ answer: 'never' });

    await expect(runner().run(request())).rejects.toBeInstanceOf(AiUnavailableError);

    expect(provider.calls).toHaveLength(1);
    // And the ledger keeps the worst-case estimate: over-counting is the safe error.
    expect(repository.totalCost()).toBeGreaterThan(0);
  });

  it('zeroes the ledger for a failure the provider certainly did not bill', async () => {
    provider.fail('rate_limited', true).fail('rate_limited', true);

    await expect(runner().run(request())).rejects.toBeInstanceOf(AiUnavailableError);

    expect(repository.totalCost()).toBe(0);
  });

  it('does not retry a malformed response, and keeps the charge', async () => {
    provider.fail('invalid_response', false).succeed({ answer: 'never' });

    await expect(runner().run(request())).rejects.toMatchObject({
      context: { kind: 'invalid_response' },
    });

    expect(provider.calls).toHaveLength(1);
    expect(repository.totalCost()).toBeGreaterThan(0);
  });

  it.each(['model_not_found', 'authentication', 'invalid_request', 'refused'] as const)(
    'does not retry %s',
    async (kind) => {
      provider.fail(kind, false).succeed({ answer: 'never' });

      await expect(runner().run(request())).rejects.toBeInstanceOf(AiUnavailableError);
      expect(provider.calls).toHaveLength(1);
    },
  );

  it('turns an unexpected exception into the same clean error, never a raw throw', async () => {
    const exploding: AiProvider = {
      complete: async () => {
        throw new TypeError('something the adapter forgot to translate');
      },
    };
    const run = new AiRunner(
      configWith(),
      exploding,
      repository as unknown as AiRepository,
      coordination,
    );

    await expect(run.run(request())).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('releases the lock even when the provider fails', async () => {
    provider.fail('timeout', false);

    await expect(runner().run(request())).rejects.toBeTruthy();
    expect(coordination.locks.size).toBe(0);
  });

  it('caches nothing from a failed call', async () => {
    provider.fail('invalid_response', false);

    await expect(runner().run(request())).rejects.toBeTruthy();
    expect(coordination.cache.size).toBe(0);
  });
});

describe('logging', () => {
  it('never logs the prompt or the question text', async () => {
    const lines: string[] = [];
    const run = runner();
    // Nest's Logger instance is private; intercept at the class level.
    const { Logger } = await import('@nestjs/common');
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    provider.fail('rate_limited', true).succeed({ answer: 'the secret answer' });

    await run.run({ ...request(), input: '1. A question containing a name: Priya Raman' });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('Priya');
      expect(line).not.toContain('secret answer');
      expect(line).not.toContain('You classify');
    }
    // What IS logged: enough to reconcile a bill.
    expect(lines.some((line) => line.includes('"feature":"CLASSIFICATION"'))).toBe(true);
    expect(lines.some((line) => line.includes('"costMicros"'))).toBe(true);
  });
});
