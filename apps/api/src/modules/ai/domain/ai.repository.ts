import type { AiCategory, AiFeature, EventStatus } from '@eventq/contracts';
import type { MinimalQuestion } from './ai-prompts';

/**
 * Port: what the AI module reads and writes.
 *
 * Declared here rather than borrowed from the questions or events modules,
 * for the same modular-monolith reason those modules keep their own: the
 * shapes are different. A model needs a question's text and status and
 * nothing else; a moderation queue needs everything but. A narrow port asks
 * for exactly what it uses — and here the narrowness IS the privacy control,
 * because a use-case cannot send a model a field the port never gave it.
 *
 * Every organizer-facing read takes `orgId` as a REQUIRED argument.
 */

/** An event as the AI features see it. Organizer-authored text and switches. */
export interface AiEventContext {
  eventId: string;
  orgId: string;
  title: string;
  description: string | null;
  status: EventStatus;
  /** The organizer's per-event switch. */
  aiEnabled: boolean;
}

/** A question as the AI features see it, plus what earlier calls produced. */
export interface AiQuestionRecord extends MinimalQuestion {
  eventId: string;
  category: string | null;
}

export interface TopicRecord {
  id: string;
  label: string;
  summary: string | null;
  questionIds: string[];
  /** When the clustering run that created it happened. */
  createdAt: Date;
}

/** How live questions were categorised, with the provenance of the labels. */
export interface CategoryBreakdownRecord {
  counts: ReadonlyArray<{ category: string; questions: number }>;
  categorized: number;
  uncategorized: number;
  modelIds: string[];
  lastCategorizedAt: Date | null;
}

export interface SummaryRecord {
  id: string;
  kind: 'LIVE' | 'FINAL';
  content: unknown;
  modelId: string | null;
  generatedAt: Date;
}

/** One row of the ledger, written BEFORE dispatch and corrected after. */
export interface UsageEntry {
  eventId: string;
  feature: AiFeature;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  cachedReadTokens: number;
  costMicros: number;
}

export interface AiRepository {
  findEventForOrg(eventId: string, orgId: string): Promise<AiEventContext | null>;
  findQuestionForOrg(questionId: string, orgId: string): Promise<AiQuestionRecord | null>;

  /** Live questions (pending, approved, answered) with no category yet. */
  findUncategorized(eventId: string, limit: number): Promise<AiQuestionRecord[]>;
  countUncategorized(eventId: string): Promise<number>;

  /** Read-only: counts the categories earlier runs stored. Calls no model. */
  categoryBreakdown(eventId: string): Promise<CategoryBreakdownRecord>;

  /** Live questions, oldest first, capped. */
  findLive(eventId: string, limit: number): Promise<AiQuestionRecord[]>;

  /**
   * Candidates for similarity: the trigram-nearest live questions on the
   * event, excluding the one being checked. Recall for the model to judge —
   * it can only pick from this list.
   */
  findSimilarityCandidates(
    eventId: string,
    questionId: string,
    normalizedBody: string,
    limit: number,
  ): Promise<MinimalQuestion[]>;

  /** Upserts the enrichment rows as COMPLETED with the model that produced them. */
  storeCategories(
    assignments: ReadonlyArray<{ questionId: string; category: AiCategory }>,
    provenance: { modelId: string; promptVersion: string },
  ): Promise<void>;

  /**
   * Writes the SAME suggestion columns the deterministic detector uses, so
   * the result flows into the existing merge / dismiss confirmation. Never
   * overwrites a suggestion a moderator has already acted on: only a question
   * with no current suggestion is written.
   */
  storeDuplicateSuggestion(
    questionId: string,
    suggestedQuestionId: string,
    confidence: number,
  ): Promise<void>;

  /** Replaces the event's topics wholesale and re-points its questions. */
  replaceTopics(
    eventId: string,
    topics: ReadonlyArray<{ label: string; summary: string; questionIds: string[] }>,
  ): Promise<TopicRecord[]>;
  findTopics(eventId: string): Promise<TopicRecord[]>;

  storeSuggestedAnswer(
    questionId: string,
    draft: { text: string; caveats: string[]; modelId: string; generatedAt: Date },
  ): Promise<void>;

  storeSummary(
    eventId: string,
    kind: 'LIVE' | 'FINAL',
    content: unknown,
    modelId: string,
  ): Promise<SummaryRecord>;
  findLatestSummary(eventId: string): Promise<SummaryRecord | null>;

  // --- The ledger ----------------------------------------------------------

  sumCostForEvent(eventId: string): Promise<number>;
  sumCostSince(since: Date): Promise<number>;
  countCallsByFeature(eventId: string): Promise<Partial<Record<AiFeature, number>>>;
  recordUsage(entry: UsageEntry): Promise<{ id: string }>;
  correctUsage(id: string, actual: Omit<UsageEntry, 'eventId' | 'feature'>): Promise<void>;
}

export const AI_REPOSITORY = Symbol('AI_REPOSITORY');

/**
 * Port: the cache and the per-event lock.
 *
 * Both are REBUILDABLE state and both are allowed to be unavailable: a cache
 * miss costs one call, a lock that cannot be taken lets a duplicate click
 * through. Neither justifies refusing the organizer, so an implementation
 * degrades to "no cache, no lock" and logs it, rather than throwing.
 */
export interface AiCoordination {
  /** True if acquired. False if held by someone else. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  getCached(key: string): Promise<string | null>;
  setCached(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const AI_COORDINATION = Symbol('AI_COORDINATION');
