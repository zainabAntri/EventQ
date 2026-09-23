import type { ModerationMode, QuestionStatus } from '@eventq/contracts';

/**
 * Port: the reads behind Event Insights.
 *
 * Read-only by construction — there is no method here that writes anything,
 * because insights observe an event, they do not change it. And nothing here
 * reads a column the product does not already keep for its own sake: every
 * count comes from questions, votes and the moderation audit trail.
 *
 * `findEventForOrg` is the ownership check and takes `orgId` as a REQUIRED
 * argument. Every other read is keyed by an event id that has already passed
 * it, which is the same discipline the AI module uses.
 *
 * No method returns an attendee id, a name, or anything else that says WHO.
 * Engagement is reported as head-counts only.
 */

export interface InsightsEventRecord {
  eventId: string;
  moderationMode: ModerationMode;
}

export interface InsightQuestionRecord {
  id: string;
  body: string;
  status: QuestionStatus;
  upvoteCount: number;
  askedByCount: number;
}

export interface EngagementCounts {
  votes: number;
  askers: number;
  voters: number;
  participants: number;
}

export interface InsightsRepository {
  findEventForOrg(eventId: string, orgId: string): Promise<InsightsEventRecord | null>;

  /** Every question ever submitted, by status — archived and merged included. */
  countByStatus(eventId: string): Promise<Record<QuestionStatus, number>>;

  /** Archived questions that were folded into another as a duplicate. */
  countMerged(eventId: string): Promise<number>;

  engagement(eventId: string): Promise<EngagementCounts>;

  /** Submission time of every question except spam, for the timeline. */
  submissionTimes(eventId: string): Promise<Date[]>;

  /** Live questions (pending, approved, answered): how many there are, and
   *  the comparison form of up to `limit` of them, newest first. */
  countLive(eventId: string): Promise<number>;
  liveNormalizedBodies(eventId: string, limit: number): Promise<string[]>;

  /** Approved or answered questions with at least one vote, most-voted first. */
  mostUpvoted(eventId: string, limit: number): Promise<InsightQuestionRecord[]>;

  /** Approved and never answered, most-supported first. */
  unanswered(eventId: string, limit: number): Promise<InsightQuestionRecord[]>;

  /** Questions that absorbed a merged duplicate, largest group first. */
  largestDuplicateGroups(eventId: string, limit: number): Promise<InsightQuestionRecord[]>;

  countDuplicateGroups(eventId: string): Promise<number>;

  /** System duplicate suggestions nobody has confirmed or dismissed yet. */
  countAwaitingDuplicateReview(eventId: string): Promise<number>;

  /** Submission → first moderator approval, from the audit trail. */
  moderationWait(
    eventId: string,
  ): Promise<{ moderatorApproved: number; medianWaitSeconds: number | null }>;
}

export const INSIGHTS_REPOSITORY = Symbol('INSIGHTS_REPOSITORY');
