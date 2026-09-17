import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { AiFeature, AiUsageSummary } from '@eventq/contracts';
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  AI_PROVIDER,
  AiProviderFailure,
  type AiFailureKind,
  type AiProvider,
} from '../domain/ai-provider.port';
import {
  AI_COORDINATION,
  AI_REPOSITORY,
  type AiCoordination,
  type AiEventContext,
  type AiRepository,
} from '../domain/ai.repository';
import { costMicros, estimateTokens, estimateWorstCaseMicros } from '../domain/ai-cost';
import { AI_LIMITS, PROMPT_VERSION } from '../domain/ai-limits';
import {
  AiBudgetExceededError,
  AiBusyError,
  AiDisabledError,
  AiUnavailableError,
} from '../domain/ai.errors';

/**
 * The one path from a use-case to a model.
 *
 * Every AI call in EventQ goes through `run`, and `run` applies the same
 * policy in the same order every time. That is what turns "handle timeouts,
 * rate limits, malformed responses, unavailable models and excessive cost"
 * from a checklist each feature might remember into a single place a
 * feature cannot bypass:
 *
 *   1. SWITCHES   off at the server or off for the event → refuse, no call
 *   2. LOCK       the same feature already running for this event → 409
 *   3. CACHE      same prompt, same version, within a day → answer, no call
 *   4. BUDGET     worst-case cost of THIS call against the ledger → refuse
 *   5. LEDGER     a row is written BEFORE dispatch, at the worst-case cost,
 *                 so a crash between the call and the correction over-counts
 *                 rather than under-counts
 *   6. DISPATCH   with a hard timeout, and at most ONE retry, only for
 *                 failures the adapter marked retryable — never a timeout
 *   7. VALIDATE   the adapter already parsed the output against the schema;
 *                 what reaches a use-case is the shape it asked for
 *   8. CORRECT    the ledger row to the provider's own token count
 *   9. LOG        feature, model, tokens, cost, duration and outcome — never
 *                 prompt text, never a question, never a name
 *
 * The retry is the only loop in this file, and its bound is a constant.
 */

export interface RunRequest<TOutput> {
  event: AiEventContext;
  feature: AiFeature;
  system: string;
  input: string;
  schema: z.ZodType<TOutput>;
}

export interface RunResult<TOutput> {
  output: TOutput;
  usage: AiUsageSummary;
}

@Injectable()
export class AiRunner {
  private readonly logger = new Logger(AiRunner.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(AI_COORDINATION) private readonly coordination: AiCoordination,
  ) {}

  /** Which model a feature uses. From configuration, never hardcoded. */
  modelFor(feature: AiFeature): string {
    const { models } = this.config.ai;
    switch (feature) {
      case 'CLASSIFICATION':
        return models.classify;
      case 'DEDUPLICATION':
        return models.dedup;
      case 'CLUSTERING':
      case 'ANSWER_SUGGESTION':
      case 'SUMMARIZATION':
        return models.insight;
    }
  }

  /** The two switches, checked without touching anything. */
  assertEnabled(event: Pick<AiEventContext, 'aiEnabled'>): void {
    if (!this.config.ai.enabled) throw new AiDisabledError('server');
    if (!event.aiEnabled) throw new AiDisabledError('event');
  }

  async run<TOutput>(request: RunRequest<TOutput>): Promise<RunResult<TOutput>> {
    // 1. Switches.
    this.assertEnabled(request.event);

    const modelId = this.modelFor(request.feature);
    const maxOutputTokens = AI_LIMITS.maxOutputTokens[request.feature];
    const lockKey = `ai:lock:${request.event.eventId}:${request.feature}`;

    // 2. Lock. One bill per click, not one per click per moderator.
    if (!(await this.coordination.acquireLock(lockKey, AI_LIMITS.lockTtlSeconds))) {
      throw new AiBusyError(request.feature);
    }

    try {
      // 3. Cache. The key covers everything that could change the answer.
      const cacheKey = this.cacheKeyFor(request, modelId);
      const cached = await this.readCache(cacheKey, request.schema);
      if (cached) {
        this.log(request, modelId, 'cache_hit', { costMicros: 0, durationMs: 0 });
        return {
          output: cached,
          usage: { modelId, inputTokens: 0, outputTokens: 0, costMicros: 0, cached: true },
        };
      }

      // 4. Budget, against the WORST case this call could cost.
      const worstCase = estimateWorstCaseMicros(
        modelId,
        request.system + request.input,
        maxOutputTokens,
      );
      await this.assertWithinBudget(request.event.eventId, worstCase);

      // 5. Ledger, before dispatch.
      const ledger = await this.repository.recordUsage({
        eventId: request.event.eventId,
        feature: request.feature,
        modelId,
        tokensIn: estimateTokens(request.system + request.input),
        tokensOut: maxOutputTokens,
        cachedReadTokens: 0,
        costMicros: worstCase,
      });

      // 6. Dispatch, bounded.
      const started = Date.now();
      const completion = await this.dispatchWithBoundedRetry(
        request,
        modelId,
        maxOutputTokens,
        ledger.id,
      );
      const durationMs = Date.now() - started;

      // 8. Correct the ledger to what was actually used.
      const actualCost = costMicros(completion.modelId, completion.usage);
      await this.repository.correctUsage(ledger.id, {
        modelId: completion.modelId,
        tokensIn: completion.usage.inputTokens,
        tokensOut: completion.usage.outputTokens,
        cachedReadTokens: completion.usage.cachedReadTokens,
        costMicros: actualCost,
      });

      await this.writeCache(cacheKey, completion.output);

      this.log(request, completion.modelId, 'ok', {
        costMicros: actualCost,
        durationMs,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
      });

      return {
        output: completion.output,
        usage: {
          modelId: completion.modelId,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          costMicros: actualCost,
          cached: false,
        },
      };
    } finally {
      await this.coordination.releaseLock(lockKey);
    }
  }

  /**
   * The retry loop. `AI_LIMITS.maxAttempts` bounds it absolutely; there is
   * no other exit than success, a non-retryable failure, or exhaustion.
   */
  private async dispatchWithBoundedRetry<TOutput>(
    request: RunRequest<TOutput>,
    modelId: string,
    maxOutputTokens: number,
    ledgerId: string,
  ) {
    let lastFailure: AiProviderFailure | null = null;

    for (let attempt = 1; attempt <= AI_LIMITS.maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        return await this.provider.complete({
          modelId,
          system: request.system,
          input: request.input,
          schema: request.schema,
          maxOutputTokens,
          timeoutMs: AI_LIMITS.timeoutMs,
        });
      } catch (caught) {
        const failure =
          caught instanceof AiProviderFailure
            ? caught
            : new AiProviderFailure('unknown', false, 'Provider threw a non-AI error', {
                cause: caught,
              });
        lastFailure = failure;

        this.log(request, modelId, `failed:${failure.kind}`, {
          attempt,
          durationMs: Date.now() - started,
          retryable: failure.retryable,
        });

        if (!failure.retryable || attempt === AI_LIMITS.maxAttempts) break;
        await sleep(AI_LIMITS.retryDelayMs);
      }
    }

    // Nothing to correct if the provider never processed the request; keep the
    // worst-case estimate if it might have. Over-counting is the safe error.
    if (lastFailure && !mayHaveBeenBilled(lastFailure.kind)) {
      await this.repository.correctUsage(ledgerId, {
        modelId,
        tokensIn: 0,
        tokensOut: 0,
        cachedReadTokens: 0,
        costMicros: 0,
      });
    }

    throw new AiUnavailableError(lastFailure?.kind ?? 'unknown', request.feature);
  }

  private async assertWithinBudget(eventId: string, worstCaseMicros: number): Promise<void> {
    const { eventBudgetMicros, monthlyBudgetMicros } = this.config.ai;

    const eventSpend = await this.repository.sumCostForEvent(eventId);
    if (eventSpend + worstCaseMicros > eventBudgetMicros) {
      throw new AiBudgetExceededError('event', eventSpend, eventBudgetMicros);
    }

    const monthSpend = await this.repository.sumCostSince(startOfMonth());
    if (monthSpend + worstCaseMicros > monthlyBudgetMicros) {
      throw new AiBudgetExceededError('month', monthSpend, monthlyBudgetMicros);
    }
  }

  private cacheKeyFor(request: RunRequest<unknown>, modelId: string): string {
    const digest = createHash('sha256')
      .update([request.feature, modelId, PROMPT_VERSION, request.system, request.input].join(' '))
      .digest('hex');
    return `ai:cache:${digest}`;
  }

  private async readCache<TOutput>(
    key: string,
    schema: z.ZodType<TOutput>,
  ): Promise<TOutput | null> {
    const raw = await this.coordination.getCached(key);
    if (!raw) return null;

    // Validated on the way OUT as well as in: a cache entry written by an
    // older shape must not reach a use-case expecting the new one.
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, output: unknown): Promise<void> {
    await this.coordination.setCached(key, JSON.stringify(output), AI_LIMITS.cacheTtlSeconds);
  }

  /**
   * Structured, and deliberately free of content. What is logged is enough
   * to reconcile a bill and diagnose an outage; nothing here could identify
   * an attendee or reproduce what they asked.
   */
  private log(
    request: RunRequest<unknown>,
    modelId: string,
    outcome: string,
    extra: Record<string, number | boolean>,
  ): void {
    const line = JSON.stringify({
      ai: true,
      feature: request.feature,
      eventId: request.event.eventId,
      modelId,
      promptVersion: PROMPT_VERSION,
      outcome,
      ...extra,
    });
    if (outcome.startsWith('failed')) this.logger.warn(line);
    else this.logger.log(line);
  }
}

/** Failures after which the provider may still have counted the request. */
function mayHaveBeenBilled(kind: AiFailureKind): boolean {
  switch (kind) {
    case 'timeout':
    case 'invalid_response':
    case 'refused':
    case 'unknown':
      return true;
    case 'rate_limited':
    case 'unavailable':
    case 'model_not_found':
    case 'authentication':
    case 'invalid_request':
      return false;
  }
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
