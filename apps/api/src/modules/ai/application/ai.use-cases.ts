import { Inject, Injectable } from '@nestjs/common';
import {
  AiFeature,
  type AiStatusResponse,
  type CategorizeResponse,
  type ClusterResponse,
  type EventSummaryResponse,
  type SimilarQuestionsResponse,
  type SuggestedAnswerResponse,
  type TopicResponse,
} from '@eventq/contracts';
import { AppConfigService } from '../../../shared/config/app-config.service';
import type { RequestContext } from '../../../shared/auth/request-context';
import { EventNotFoundError } from '../../events/domain/event.errors';
import { QuestionNotFoundError } from '../../questions/domain/question.errors';
// A pure function from the questions domain, imported rather than restated:
// candidates for similarity must be folded exactly as the trigram index was.
import { normalizeForComparison } from '../../questions/domain/question-text';
import {
  AI_REPOSITORY,
  type AiEventContext,
  type AiRepository,
  type SummaryRecord,
  type TopicRecord,
} from '../domain/ai.repository';
import { AI_LIMITS, PROMPT_VERSION } from '../domain/ai-limits';
import {
  buildAnswerPrompt,
  buildCategorizePrompt,
  buildClusterPrompt,
  buildSimilarPrompt,
  buildSummaryPrompt,
  validateCategorize,
  validateCluster,
  validateSimilar,
  validateSummary,
  type SummaryResult,
} from '../domain/ai-prompts';
import { AiRunner } from './ai-runner';

/**
 * AI use-cases.
 *
 * Each one has the same three-beat shape: load what the model may see
 * (org-scoped, minimal), run it through the runner, store what survived
 * validation. None of them changes a question's status, and none of them
 * writes to anything an attendee reads — see the repository port for the
 * exact columns each touches.
 *
 * Every use-case takes the organization from the session, never from the
 * request, and an event or question in another organization is "not found",
 * identical to one that does not exist.
 */

/** Where an event stands: switches, spend, and what each button would use. */
@Injectable()
export class GetAiStatusUseCase {
  constructor(
    private readonly config: AppConfigService,
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<AiStatusResponse> {
    const event = await requireEvent(this.repository, eventId, context);

    const [eventSpend, monthlySpend, calls] = await Promise.all([
      this.repository.sumCostForEvent(event.eventId),
      this.repository.sumCostSince(startOfMonth()),
      this.repository.countCallsByFeature(event.eventId),
    ]);

    return {
      availableOnServer: this.config.ai.enabled,
      enabledForEvent: event.aiEnabled,
      eventSpendMicros: eventSpend,
      eventBudgetMicros: this.config.ai.eventBudgetMicros,
      monthlySpendMicros: monthlySpend,
      monthlyBudgetMicros: this.config.ai.monthlyBudgetMicros,
      callsByFeature: Object.fromEntries(
        AiFeature.options.map((feature) => [feature, calls[feature] ?? 0]),
      ) as AiStatusResponse['callsByFeature'],
      models: Object.fromEntries(
        AiFeature.options.map((feature) => [feature, this.runner.modelFor(feature)]),
      ) as AiStatusResponse['models'],
    };
  }
}

/** 1. Categorisation: one batch of uncategorised questions per click. */
@Injectable()
export class CategorizeQuestionsUseCase {
  constructor(
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<CategorizeResponse> {
    const event = await requireEvent(this.repository, eventId, context);
    this.runner.assertEnabled(event);

    const questions = await this.repository.findUncategorized(
      event.eventId,
      AI_LIMITS.maxQuestionsPerCall.CLASSIFICATION,
    );
    if (questions.length === 0) {
      return { categorized: 0, rejected: 0, remaining: 0, usage: null };
    }

    const prompt = buildCategorizePrompt(event, questions);
    const { output, usage } = await this.runner.run({
      event,
      feature: 'CLASSIFICATION',
      ...prompt,
    });

    const result = validateCategorize(output, questions);
    await this.repository.storeCategories(result.assignments, {
      modelId: usage.modelId,
      promptVersion: PROMPT_VERSION,
    });

    return {
      categorized: result.assignments.length,
      rejected: result.rejected,
      remaining: await this.repository.countUncategorized(event.eventId),
      usage,
    };
  }
}

/** 2. Similar-question detection for one question, into the existing suggestion. */
@Injectable()
export class FindSimilarQuestionUseCase {
  constructor(
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(questionId: string, context: RequestContext): Promise<SimilarQuestionsResponse> {
    const question = await this.repository.findQuestionForOrg(questionId, context.orgId);
    if (!question) throw new QuestionNotFoundError();
    const event = await requireEvent(this.repository, question.eventId, context);
    this.runner.assertEnabled(event);

    const candidates = await this.repository.findSimilarityCandidates(
      event.eventId,
      question.id,
      normalizeForComparison(question.body),
      AI_LIMITS.maxQuestionsPerCall.DEDUPLICATION,
    );

    // Nothing to compare against is an answer, not a call.
    if (candidates.length === 0) {
      return {
        questionId: question.id,
        suggestion: null,
        usage: {
          modelId: this.runner.modelFor('DEDUPLICATION'),
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          cached: true,
        },
      };
    }

    const prompt = buildSimilarPrompt(event, question, candidates);
    const { output, usage } = await this.runner.run({
      event,
      feature: 'DEDUPLICATION',
      ...prompt,
    });

    const result = validateSimilar(output, candidates);
    if (!result.match) return { questionId: question.id, suggestion: null, usage };

    await this.repository.storeDuplicateSuggestion(
      question.id,
      result.match.questionId,
      result.match.confidence,
    );

    const matched = candidates.find((candidate) => candidate.id === result.match!.questionId)!;
    return {
      questionId: question.id,
      suggestion: {
        questionId: matched.id,
        body: matched.body,
        confidence: result.match.confidence,
        reason: result.match.reason,
      },
      usage,
    };
  }
}

/** 3. Clustering: the whole event's live questions into topics. */
@Injectable()
export class ClusterQuestionsUseCase {
  constructor(
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<ClusterResponse> {
    const event = await requireEvent(this.repository, eventId, context);
    this.runner.assertEnabled(event);

    const questions = await this.repository.findLive(
      event.eventId,
      AI_LIMITS.maxQuestionsPerCall.CLUSTERING,
    );
    // A topic needs two questions; an event with fewer has no clustering to do.
    if (questions.length < 2) {
      return { topics: [], unclustered: questions.length, usage: null };
    }

    const prompt = buildClusterPrompt(event, questions);
    const { output, usage } = await this.runner.run({ event, feature: 'CLUSTERING', ...prompt });

    const result = validateCluster(output, questions);
    const topics = await this.repository.replaceTopics(event.eventId, result.topics);

    return { topics: topics.map(toTopicResponse), unclustered: result.unclustered, usage };
  }
}

@Injectable()
export class ListTopicsUseCase {
  constructor(@Inject(AI_REPOSITORY) private readonly repository: AiRepository) {}

  async execute(eventId: string, context: RequestContext): Promise<TopicResponse[]> {
    const event = await requireEvent(this.repository, eventId, context);
    return (await this.repository.findTopics(event.eventId)).map(toTopicResponse);
  }
}

/** 4. A drafted answer, stored as a draft. */
@Injectable()
export class SuggestAnswerUseCase {
  constructor(
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(questionId: string, context: RequestContext): Promise<SuggestedAnswerResponse> {
    const question = await this.repository.findQuestionForOrg(questionId, context.orgId);
    if (!question) throw new QuestionNotFoundError();
    const event = await requireEvent(this.repository, question.eventId, context);
    this.runner.assertEnabled(event);

    const prompt = buildAnswerPrompt(event, question);
    const { output, usage } = await this.runner.run({
      event,
      feature: 'ANSWER_SUGGESTION',
      ...prompt,
    });

    const generatedAt = new Date();
    await this.repository.storeSuggestedAnswer(question.id, {
      text: output.draft.trim(),
      caveats: output.caveats.map((caveat) => caveat.trim()).filter(Boolean),
      modelId: usage.modelId,
      generatedAt,
    });

    return {
      questionId: question.id,
      draft: output.draft.trim(),
      caveats: output.caveats.map((caveat) => caveat.trim()).filter(Boolean),
      modelId: usage.modelId,
      generatedAt: generatedAt.toISOString(),
      usage,
    };
  }
}

/** 5. The event summary: LIVE while it runs, FINAL once closed. */
@Injectable()
export class SummarizeEventUseCase {
  constructor(
    private readonly runner: AiRunner,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<EventSummaryResponse> {
    const event = await requireEvent(this.repository, eventId, context);
    this.runner.assertEnabled(event);

    const questions = await this.repository.findLive(
      event.eventId,
      AI_LIMITS.maxQuestionsPerCall.SUMMARIZATION,
    );

    const prompt = buildSummaryPrompt(event, questions);
    const { output, usage } = await this.runner.run({ event, feature: 'SUMMARIZATION', ...prompt });

    const result = validateSummary(output, questions);
    const statusById = new Map(questions.map((question) => [question.id, question.status]));
    const content: StoredSummary = {
      ...result,
      notableQuestions: result.notableQuestions.map((item) => ({
        ...item,
        status: statusById.get(item.questionId) ?? 'PENDING',
      })),
      questionCount: questions.length,
    };

    const stored = await this.repository.storeSummary(
      event.eventId,
      event.status === 'CLOSED' ? 'FINAL' : 'LIVE',
      content,
      usage.modelId,
    );

    return toSummaryResponse(stored, content, usage);
  }
}

@Injectable()
export class GetLatestSummaryUseCase {
  constructor(@Inject(AI_REPOSITORY) private readonly repository: AiRepository) {}

  async execute(eventId: string, context: RequestContext): Promise<EventSummaryResponse | null> {
    const event = await requireEvent(this.repository, eventId, context);
    const stored = await this.repository.findLatestSummary(event.eventId);
    if (!stored) return null;

    // A stored blob is data, not something to trust: it is validated on the
    // way out, and a row written by an older shape reads as "no summary"
    // rather than crashing the panel.
    const content = readStoredSummary(stored.content);
    return content ? toSummaryResponse(stored, content, null) : null;
  }
}

// ---------------------------------------------------------------------------

/** The JSON shape kept in event_summaries.content. */
interface StoredSummary extends SummaryResult {
  notableQuestions: Array<{ questionId: string; why: string; status: string }>;
  questionCount: number;
}

function readStoredSummary(value: unknown): StoredSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<StoredSummary>;
  if (typeof candidate.headline !== 'string' || !Array.isArray(candidate.themes)) return null;
  return {
    headline: candidate.headline,
    themes: candidate.themes,
    notableQuestions: Array.isArray(candidate.notableQuestions) ? candidate.notableQuestions : [],
    suggestedFollowUps: Array.isArray(candidate.suggestedFollowUps)
      ? candidate.suggestedFollowUps
      : [],
    questionCount: typeof candidate.questionCount === 'number' ? candidate.questionCount : 0,
  };
}

function toSummaryResponse(
  stored: SummaryRecord,
  content: StoredSummary,
  usage: EventSummaryResponse['usage'],
): EventSummaryResponse {
  return {
    id: stored.id,
    kind: stored.kind,
    headline: content.headline,
    themes: content.themes,
    notableQuestions: content.notableQuestions as EventSummaryResponse['notableQuestions'],
    suggestedFollowUps: content.suggestedFollowUps,
    questionCount: content.questionCount,
    modelId: stored.modelId ?? 'unknown',
    generatedAt: stored.generatedAt.toISOString(),
    usage,
  };
}

function toTopicResponse(topic: TopicRecord): TopicResponse {
  return {
    id: topic.id,
    label: topic.label,
    summary: topic.summary,
    questionCount: topic.questionIds.length,
    questionIds: topic.questionIds,
  };
}

async function requireEvent(
  repository: AiRepository,
  eventId: string,
  context: RequestContext,
): Promise<AiEventContext> {
  const event = await repository.findEventForOrg(eventId, context.orgId);
  if (!event) throw new EventNotFoundError();
  return event;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
