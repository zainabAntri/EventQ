import { Inject, Injectable } from '@nestjs/common';
import type { EventInsightsResponse, InsightQuestion } from '@eventq/contracts';
import type { RequestContext } from '../../../shared/auth/request-context';
import { EventNotFoundError } from '../../events/domain/event.errors';
import { answerRate, buildTimeline, frequentTerms } from '../domain/insight-metrics';
import {
  INSIGHTS_REPOSITORY,
  type InsightQuestionRecord,
  type InsightsRepository,
} from '../domain/insights.repository';

/**
 * How many live questions the term count reads.
 *
 * The only part of insights that loads rows rather than counting them. Five
 * thousand bodies is a few hundred kilobytes, read once when an organizer
 * opens the page; beyond that the response says it was truncated rather than
 * quietly presenting a sample as the whole.
 */
export const TERM_ANALYSIS_LIMIT = 5_000;

/** Length of the follow-up list and the duplicate-group list. */
const UNANSWERED_LIMIT = 5;
const DUPLICATE_GROUP_LIMIT = 3;

/**
 * Event Insights: measured facts about one event.
 *
 * Every figure is counted from data the product already keeps. There is no
 * model anywhere on this path — the AI interpretation of the same event is a
 * separate set of endpoints, and the contract this returns has no field one
 * could fill.
 */
@Injectable()
export class GetEventInsightsUseCase {
  constructor(@Inject(INSIGHTS_REPOSITORY) private readonly repository: InsightsRepository) {}

  async execute(eventId: string, context: RequestContext): Promise<EventInsightsResponse> {
    const event = await this.repository.findEventForOrg(eventId, context.orgId);
    // The same 404 as an event that does not exist, so ids cannot be probed.
    if (!event) throw new EventNotFoundError();

    const id = event.eventId;
    const [
      byStatus,
      merged,
      engagement,
      submittedAt,
      liveCount,
      bodies,
      mostUpvoted,
      unanswered,
      duplicateGroups,
      groupCount,
      awaitingReview,
      wait,
    ] = await Promise.all([
      this.repository.countByStatus(id),
      this.repository.countMerged(id),
      this.repository.engagement(id),
      this.repository.submissionTimes(id),
      this.repository.countLive(id),
      this.repository.liveNormalizedBodies(id, TERM_ANALYSIS_LIMIT),
      this.repository.mostUpvoted(id, 1),
      this.repository.unanswered(id, UNANSWERED_LIMIT),
      this.repository.largestDuplicateGroups(id, DUPLICATE_GROUP_LIMIT),
      this.repository.countDuplicateGroups(id),
      this.repository.countAwaitingDuplicateReview(id),
      this.repository.moderationWait(id),
    ]);

    const submitted = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const timeline = buildTimeline(submittedAt);

    return {
      eventId: id,
      computedAt: new Date().toISOString(),
      questions: {
        submitted,
        byStatus,
        mergedAsDuplicate: merged,
        unanswered: byStatus.APPROVED,
        answerRate: answerRate(byStatus.APPROVED, byStatus.ANSWERED),
      },
      engagement,
      highlights: {
        mostUpvoted: mostUpvoted[0] ? toInsightQuestion(mostUpvoted[0]) : null,
        mostAsked: duplicateGroups[0] ? toInsightQuestion(duplicateGroups[0]) : null,
        unanswered: unanswered.map(toInsightQuestion),
      },
      timeline: {
        bucketMinutes: timeline.bucketMinutes,
        buckets: timeline.buckets.map((bucket) => ({
          start: bucket.start.toISOString(),
          count: bucket.count,
        })),
      },
      duplicates: {
        groups: groupCount,
        awaitingReview,
        largest: duplicateGroups.map(toInsightQuestion),
      },
      moderation: {
        mode: event.moderationMode,
        moderatorApproved: wait.moderatorApproved,
        medianWaitSeconds: wait.medianWaitSeconds,
      },
      frequentTerms: {
        analysed: bodies.length,
        truncated: liveCount > bodies.length,
        terms: frequentTerms(bodies),
      },
    };
  }
}

function toInsightQuestion(record: InsightQuestionRecord): InsightQuestion {
  return {
    id: record.id,
    body: record.body,
    status: record.status,
    upvoteCount: record.upvoteCount,
    askedByCount: record.askedByCount,
  };
}
