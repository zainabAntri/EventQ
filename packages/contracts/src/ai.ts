import { z } from 'zod';
import { EntityId } from './primitives.js';
import { AiFeature, QuestionStatus } from './enums.js';

/**
 * AI enrichment contracts.
 *
 * Everything here is a SUGGESTION. The word is chosen carefully and the
 * shapes enforce it: no response in this file can change a question's
 * status, publish an answer, or show anything to an attendee. A model
 * proposes; the organizer disposes. Every AI-produced field also carries the
 * model that produced it and when, so the dashboard can label it honestly
 * rather than presenting it as something a person said.
 *
 * AI is off by default at two levels — the server (`AI_ENABLED`) and the
 * event (`settings.aiEnabled`) — and every endpoint below refuses with
 * `AI_DISABLED` unless both are on. The product is complete without any of it.
 */

/**
 * The fixed category set.
 *
 * A closed list rather than free text, and the reason is validation: a model
 * can only ever be wrong within this set, never inventive outside it. An
 * answer that is not one of these is a MALFORMED response and is discarded,
 * not stored — "Other" exists so the model always has an honest choice.
 */
export const AiCategory = z.enum([
  'Business',
  'Marketing',
  'Finance',
  'Technology',
  'AI',
  'Networking',
  'Operations',
  'Other',
]);
export type AiCategory = z.infer<typeof AiCategory>;

/**
 * Where an event stands with AI: switches, spend and headroom.
 *
 * Shown on the dashboard before any button is offered, so the organizer sees
 * the cost of what they have done and the ceiling they cannot cross. Amounts
 * are micro-dollars (1_000_000 = $1.00), integers, no float drift on money.
 */
export const AiStatusResponse = z.object({
  /** The server-wide switch. When false nothing can be turned on per event. */
  availableOnServer: z.boolean(),
  /** The organizer's own switch for this event. */
  enabledForEvent: z.boolean(),
  /** Spend so far on this event, in micro-dollars. */
  eventSpendMicros: z.number().int().nonnegative(),
  eventBudgetMicros: z.number().int().nonnegative(),
  /** Spend this calendar month across every event, in micro-dollars. */
  monthlySpendMicros: z.number().int().nonnegative(),
  monthlyBudgetMicros: z.number().int().nonnegative(),
  /** Calls made for this event, by feature. */
  callsByFeature: z.record(AiFeature, z.number().int().nonnegative()),
  /** Which model each feature would use, so the cost is not a surprise. */
  models: z.record(AiFeature, z.string()),
});
export type AiStatusResponse = z.infer<typeof AiStatusResponse>;

/** Cost and token usage of one AI call, echoed so every result shows its price. */
export const AiUsageSummary = z.object({
  modelId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  /** True when the result came from the cache and no model was called. */
  cached: z.boolean(),
});
export type AiUsageSummary = z.infer<typeof AiUsageSummary>;

/** Result of categorizing a batch of questions. */
export const CategorizeResponse = z.object({
  /** Questions given a category in this call. */
  categorized: z.number().int().nonnegative(),
  /** Questions the model answered for but with a value outside the fixed
   *  set — discarded rather than stored, and counted so it is visible. */
  rejected: z.number().int().nonnegative(),
  /** Questions still without a category after this call. Zero means done. */
  remaining: z.number().int().nonnegative(),
  usage: AiUsageSummary.nullable(),
});
export type CategorizeResponse = z.infer<typeof CategorizeResponse>;

/** Result of asking whether a question repeats another. */
export const SimilarQuestionsResponse = z.object({
  questionId: EntityId,
  /**
   * The question the model judged to be the same, if any — written as the
   * SAME suggestion the deterministic detector uses, so it flows into the
   * existing Merge / Not-a-duplicate confirmation rather than a second one.
   */
  suggestion: z
    .object({
      questionId: EntityId,
      body: z.string(),
      /** The model's own confidence, 0–1. Shown, not acted on. */
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    })
    .nullable(),
  usage: AiUsageSummary,
});
export type SimilarQuestionsResponse = z.infer<typeof SimilarQuestionsResponse>;

export const TopicResponse = z.object({
  id: EntityId,
  label: z.string(),
  summary: z.string().nullable(),
  questionCount: z.number().int().nonnegative(),
  questionIds: z.array(EntityId),
});
export type TopicResponse = z.infer<typeof TopicResponse>;

/** Result of grouping an event's questions into topics. */
export const ClusterResponse = z.object({
  topics: z.array(TopicResponse),
  /** Questions the model did not place anywhere. Left untouched. */
  unclustered: z.number().int().nonnegative(),
  usage: AiUsageSummary.nullable(),
});
export type ClusterResponse = z.infer<typeof ClusterResponse>;

/**
 * An AI-drafted answer.
 *
 * `caveats` is what the model said it was unsure about, and it is required
 * in the schema so a draft cannot arrive looking more certain than it is. The
 * dashboard shows both, under a label that says where it came from.
 */
export const SuggestedAnswerResponse = z.object({
  questionId: EntityId,
  draft: z.string(),
  caveats: z.array(z.string()),
  modelId: z.string(),
  generatedAt: z.iso.datetime(),
  usage: AiUsageSummary,
});
export type SuggestedAnswerResponse = z.infer<typeof SuggestedAnswerResponse>;

/** The stored draft, as carried on a question for the moderator's card. */
export const AiSuggestedAnswer = z.object({
  draft: z.string(),
  caveats: z.array(z.string()),
  modelId: z.string(),
  generatedAt: z.iso.datetime(),
});
export type AiSuggestedAnswer = z.infer<typeof AiSuggestedAnswer>;

/** An event summary, LIVE while the event runs and FINAL once it has closed. */
export const EventSummaryResponse = z.object({
  id: EntityId,
  kind: z.enum(['LIVE', 'FINAL']),
  headline: z.string(),
  themes: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      questionIds: z.array(EntityId),
    }),
  ),
  /** Questions the model thought worth the organizer's attention, validated
   *  against the questions that were actually sent. */
  notableQuestions: z.array(
    z.object({ questionId: EntityId, status: QuestionStatus, why: z.string() }),
  ),
  suggestedFollowUps: z.array(z.string()),
  /** How many questions the summary was built from. */
  questionCount: z.number().int().nonnegative(),
  modelId: z.string(),
  generatedAt: z.iso.datetime(),
  usage: AiUsageSummary.nullable(),
});
export type EventSummaryResponse = z.infer<typeof EventSummaryResponse>;
