import { Injectable } from '@nestjs/common';
import { QuestionStatus, type ModerationMode } from '@eventq/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  EngagementCounts,
  InsightQuestionRecord,
  InsightsEventRecord,
  InsightsRepository,
} from '../domain/insights.repository';

/**
 * Prisma adapter for Event Insights.
 *
 * Every query is keyed on `eventId` and served by an index that already
 * exists for the moderation queue or the board — insights added no index and
 * no column. The page is loaded on demand, never polled, so a handful of
 * small aggregate queries per view is the whole cost.
 *
 * The question `select` below names the five fields the contract shows and
 * nothing else: no attendee relation, no name, so nothing that identifies an
 * asker can reach the insights response by accident.
 */

const LIVE_STATUSES: QuestionStatus[] = ['PENDING', 'APPROVED', 'ANSWERED'];

const INSIGHT_QUESTION_SELECTION = {
  id: true,
  body: true,
  status: true,
  upvoteCount: true,
  askedByCount: true,
} as const satisfies Prisma.QuestionSelect;

@Injectable()
export class PrismaInsightsRepository implements InsightsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEventForOrg(eventId: string, orgId: string): Promise<InsightsEventRecord | null> {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, orgId, deletedAt: null },
      select: { id: true, settings: { select: { moderationMode: true } } },
    });
    if (!event) return null;

    return {
      eventId: event.id,
      // The schema default, for an event created before settings existed.
      moderationMode: (event.settings?.moderationMode ?? 'PRE') as ModerationMode,
    };
  }

  async countByStatus(eventId: string): Promise<Record<QuestionStatus, number>> {
    // Not filtered on deletedAt: archived questions were still submitted, and
    // "how many questions did we get" must count them.
    const grouped = await this.prisma.question.groupBy({
      by: ['status'],
      where: { eventId },
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      QuestionStatus.options.map((status) => [status, 0]),
    ) as Record<QuestionStatus, number>;
    for (const group of grouped) counts[group.status] = group._count._all;
    return counts;
  }

  countMerged(eventId: string): Promise<number> {
    return this.prisma.question.count({
      where: { eventId, mergedIntoQuestionId: { not: null } },
    });
  }

  async engagement(eventId: string): Promise<EngagementCounts> {
    // Votes have no eventId of their own; they reach the event through their
    // question. A merge MOVES vote rows to the survivor, so each vote row is
    // counted exactly once here however many merges happened.
    //
    // A tagged template, not $queryRawUnsafe: the event id travels as a bound
    // parameter and is never spliced into the SQL text.
    const [row] = await this.prisma.$queryRaw<
      Array<{ votes: number; askers: number; voters: number; participants: number }>
    >`
      WITH event_questions AS (
        SELECT id, "attendeeId" FROM questions WHERE "eventId" = ${eventId}::uuid
      ),
      event_votes AS (
        SELECT v."attendeeId"
        FROM question_votes v
        JOIN event_questions q ON q.id = v."questionId"
      )
      SELECT
        (SELECT count(*) FROM event_votes)::int                          AS votes,
        (SELECT count(DISTINCT "attendeeId") FROM event_questions)::int AS askers,
        (SELECT count(DISTINCT "attendeeId") FROM event_votes)::int     AS voters,
        (SELECT count(*) FROM (
           SELECT "attendeeId" FROM event_questions
           UNION
           SELECT "attendeeId" FROM event_votes
         ) AS people)::int                                               AS participants
    `;

    return row ?? { votes: 0, askers: 0, voters: 0, participants: 0 };
  }

  async submissionTimes(eventId: string): Promise<Date[]> {
    const rows = await this.prisma.question.findMany({
      where: { eventId, status: { not: 'SPAM' } },
      select: { createdAt: true },
    });
    return rows.map((row) => row.createdAt);
  }

  countLive(eventId: string): Promise<number> {
    return this.prisma.question.count({
      where: { eventId, deletedAt: null, status: { in: LIVE_STATUSES } },
    });
  }

  async liveNormalizedBodies(eventId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.question.findMany({
      where: { eventId, deletedAt: null, status: { in: LIVE_STATUSES } },
      select: { normalizedBody: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => row.normalizedBody);
  }

  mostUpvoted(eventId: string, limit: number): Promise<InsightQuestionRecord[]> {
    return this.prisma.question.findMany({
      where: {
        eventId,
        deletedAt: null,
        status: { in: ['APPROVED', 'ANSWERED'] },
        upvoteCount: { gt: 0 },
      },
      select: INSIGHT_QUESTION_SELECTION,
      orderBy: [{ upvoteCount: 'desc' }, { askedByCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  unanswered(eventId: string, limit: number): Promise<InsightQuestionRecord[]> {
    // Ordered by support, not by rankScore: the rank blends in recency, which
    // is right for a live board and wrong for a follow-up list read after the
    // event, where the last question asked is not the most important one.
    return this.prisma.question.findMany({
      where: { eventId, deletedAt: null, status: 'APPROVED' },
      select: INSIGHT_QUESTION_SELECTION,
      orderBy: [{ upvoteCount: 'desc' }, { askedByCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  largestDuplicateGroups(eventId: string, limit: number): Promise<InsightQuestionRecord[]> {
    return this.prisma.question.findMany({
      where: { eventId, deletedAt: null, askedByCount: { gt: 1 } },
      select: INSIGHT_QUESTION_SELECTION,
      orderBy: [{ askedByCount: 'desc' }, { upvoteCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  countDuplicateGroups(eventId: string): Promise<number> {
    return this.prisma.question.count({
      where: { eventId, deletedAt: null, askedByCount: { gt: 1 } },
    });
  }

  countAwaitingDuplicateReview(eventId: string): Promise<number> {
    return this.prisma.question.count({
      where: { eventId, deletedAt: null, possibleDuplicateOfQuestionId: { not: null } },
    });
  }

  async moderationWait(
    eventId: string,
  ): Promise<{ moderatorApproved: number; medianWaitSeconds: number | null }> {
    // Driven from the event's questions INTO the audit trail, so the lookup
    // uses the (questionId, createdAt) index on moderation_actions rather than
    // grouping every approval ever recorded. The FIRST approval is the wait:
    // a question rejected, restored and approved again was visible from the
    // first time, not the last.
    const [row] = await this.prisma.$queryRaw<Array<{ approved: number; median: number | null }>>`
      SELECT
        count(*)::int AS approved,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY wait)::float8 AS median
      FROM (
        SELECT EXTRACT(EPOCH FROM (min(a."createdAt") - q."createdAt")) AS wait
        FROM questions q
        JOIN moderation_actions a
          ON a."questionId" = q.id AND a.action = 'approve' AND a."actorType" = 'USER'
        WHERE q."eventId" = ${eventId}::uuid
        GROUP BY q.id, q."createdAt"
      ) AS waits
    `;

    return {
      moderatorApproved: row?.approved ?? 0,
      medianWaitSeconds:
        row?.median === null || row?.median === undefined ? null : Math.max(0, row.median),
    };
  }
}
