import { z } from 'zod';
import { EntityId } from './primitives.js';
import { ModerationMode, QuestionStatus } from './enums.js';

/**
 * Event Insights — what happened at an event, as MEASURED FACTS.
 *
 * Two rules shape everything in this file.
 *
 * 1. Nothing here is collected for insights. Every number is derived from rows
 *    the product already keeps in order to work — questions, votes, and the
 *    moderation audit trail. Insights added no tracking: no page views, no
 *    devices, no locations, no per-attendee profile. A metric that would need
 *    new collection is not here, and each field below says what decision it
 *    helps an organizer make; one that could not say that was left out.
 *
 * 2. Nothing here came from a model. This shape has no field an AI could
 *    fill, so an interpretation cannot be presented as a fact by accident —
 *    it would have to be added to this file, where it would be visible for
 *    what it is. AI-derived views of the same event (categories, topics, the
 *    summary) are served by the `/ai/*` endpoints in ./ai.ts, and the
 *    dashboard renders them in a separate, labelled section.
 */

/** A question as the insights view cites it: enough to recognise it, nothing about who asked. */
export const InsightQuestion = z.object({
  id: EntityId,
  body: z.string(),
  status: QuestionStatus,
  upvoteCount: z.number().int().nonnegative(),
  /** Author plus everyone whose duplicate was merged into this. Never below 1. */
  askedByCount: z.number().int().positive(),
});
export type InsightQuestion = z.infer<typeof InsightQuestion>;

export const EventInsightsResponse = z.object({
  eventId: EntityId,
  /** When these numbers were computed. Insights are a snapshot, not a stream. */
  computedAt: z.iso.datetime(),

  /**
   * Volume and outcome. "How big was this, and what happened to it?"
   *
   * `submitted` counts every question ever sent, whatever became of it.
   * `byStatus` includes zeros so a client never has to tell "none" from "not
   * reported". `mergedAsDuplicate` is the subset of ARCHIVED that was folded
   * into another question — demand that was consolidated, not discarded.
   */
  questions: z.object({
    submitted: z.number().int().nonnegative(),
    byStatus: z.record(QuestionStatus, z.number().int().nonnegative()),
    mergedAsDuplicate: z.number().int().nonnegative(),
    /**
     * Approved but never answered: the follow-up workload. Equal to
     * `byStatus.APPROVED`, named separately because it is the number an
     * organizer acts on after the event.
     */
    unanswered: z.number().int().nonnegative(),
    /**
     * ANSWERED ÷ (APPROVED + ANSWERED), 0–1. "Did the session cover what the
     * room asked?" Null when nothing was approved, because 0% of nothing is
     * not a result.
     */
    answerRate: z.number().min(0).max(1).nullable(),
  }),

  /**
   * Breadth of participation. "Was this two loud people, or the whole room?"
   *
   * Counts of distinct attendee identities, which are pseudonymous and scoped
   * to this one event — so these are head-counts, never a list of who.
   */
  engagement: z.object({
    votes: z.number().int().nonnegative(),
    askers: z.number().int().nonnegative(),
    voters: z.number().int().nonnegative(),
    /** Asked, voted, or both. */
    participants: z.number().int().nonnegative(),
  }),

  /**
   * What the room most wanted. `unanswered` is the follow-up list: approved
   * questions nobody answered, most-supported first.
   */
  highlights: z.object({
    mostUpvoted: InsightQuestion.nullable(),
    /** Highest `askedByCount` — only reported when a duplicate was merged,
     *  since otherwise every question ties at one. */
    mostAsked: InsightQuestion.nullable(),
    unanswered: z.array(InsightQuestion),
  }),

  /**
   * Questions submitted over time, spam excluded. "When did the room engage?"
   * — so the next Q&A slot goes where the questions actually came.
   *
   * Bucket size is chosen from the event's own span so a two-hour meetup and
   * a two-day conference both get a readable number of bars.
   */
  timeline: z.object({
    bucketMinutes: z.number().int().positive(),
    buckets: z.array(z.object({ start: z.iso.datetime(), count: z.number().int().nonnegative() })),
  }),

  /**
   * Demand concentration. "Which questions did several people ask?"
   *
   * `groups` are questions that absorbed at least one merged duplicate;
   * `awaitingReview` are system suggestions a moderator has not yet confirmed
   * or dismissed — they are NOT counted as duplicates until someone has.
   */
  duplicates: z.object({
    groups: z.number().int().nonnegative(),
    awaitingReview: z.number().int().nonnegative(),
    largest: z.array(InsightQuestion),
  }),

  /**
   * How long attendees waited for approval. "Is moderation a bottleneck?"
   *
   * Measured from submission to a moderator's first approval, from the audit
   * trail. Questions approved automatically (post-moderation) have no wait
   * and are not counted, so under POST this is usually null.
   */
  moderation: z.object({
    mode: ModerationMode,
    moderatorApproved: z.number().int().nonnegative(),
    medianWaitSeconds: z.number().nonnegative().nullable(),
  }),

  /**
   * Words that recur across questions. "What came up?" — at zero cost, with
   * AI off.
   *
   * A COUNT, not an interpretation: each term is a content word (stopwords
   * removed, plurals folded) and `questions` is how many live questions
   * contain it. It cannot tell "AI" the topic from "AI" in passing, and the
   * shares overlap — one question can mention three terms — so they do not
   * sum to 100%.
   */
  frequentTerms: z.object({
    /** Live questions the terms were counted over. */
    analysed: z.number().int().nonnegative(),
    /** True when the event had more live questions than were analysed. */
    truncated: z.boolean(),
    terms: z.array(
      z.object({
        term: z.string(),
        questions: z.number().int().positive(),
        /** questions ÷ analysed, 0–1. */
        share: z.number().min(0).max(1),
      }),
    ),
  }),
});
export type EventInsightsResponse = z.infer<typeof EventInsightsResponse>;
