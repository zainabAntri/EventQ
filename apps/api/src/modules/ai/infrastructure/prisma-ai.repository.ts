import { Injectable } from '@nestjs/common';
import type { AiCategory, AiFeature, EventStatus, QuestionStatus } from '@eventq/contracts';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { MinimalQuestion } from '../domain/ai-prompts';
import type {
  AiEventContext,
  CategoryBreakdownRecord,
  AiQuestionRecord,
  AiRepository,
  SummaryRecord,
  TopicRecord,
  UsageEntry,
} from '../domain/ai.repository';

/**
 * Prisma adapter for the AI repository.
 *
 * The `select` clauses here are the privacy boundary in code form. Every
 * question read names `id`, `body`, `status` and nothing else — no attendee
 * relation, no names, no vote counts — so a use-case that wanted to leak a
 * field to a model would first have to change this file, where the change
 * would be visible for what it is.
 */

/** Statuses a model is allowed to see. Rejected and spam are not questions
 *  the organizer wants categorised, grouped or summarised. */
const LIVE_STATUSES: readonly QuestionStatus[] = ['PENDING', 'APPROVED', 'ANSWERED'];

const QUESTION_SELECTION = {
  id: true,
  eventId: true,
  body: true,
  status: true,
  enrichment: { select: { category: true } },
} as const;

@Injectable()
export class PrismaAiRepository implements AiRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEventForOrg(eventId: string, orgId: string): Promise<AiEventContext | null> {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, orgId, deletedAt: null },
      select: {
        id: true,
        orgId: true,
        title: true,
        description: true,
        status: true,
        settings: { select: { aiEnabled: true } },
      },
    });
    if (!event) return null;

    return {
      eventId: event.id,
      orgId: event.orgId,
      title: event.title,
      description: event.description,
      status: event.status as EventStatus,
      // Missing settings read as OFF: the safe default for anything that costs money.
      aiEnabled: event.settings?.aiEnabled ?? false,
    };
  }

  async findQuestionForOrg(questionId: string, orgId: string): Promise<AiQuestionRecord | null> {
    const question = await this.prisma.question.findFirst({
      where: { id: questionId, event: { orgId, deletedAt: null }, deletedAt: null },
      select: QUESTION_SELECTION,
    });
    return question ? toRecord(question) : null;
  }

  async findUncategorized(eventId: string, limit: number): Promise<AiQuestionRecord[]> {
    const rows = await this.prisma.question.findMany({
      where: {
        eventId,
        deletedAt: null,
        status: { in: [...LIVE_STATUSES] },
        OR: [{ enrichment: null }, { enrichment: { category: null } }],
      },
      select: QUESTION_SELECTION,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  countUncategorized(eventId: string): Promise<number> {
    return this.prisma.question.count({
      where: {
        eventId,
        deletedAt: null,
        status: { in: [...LIVE_STATUSES] },
        OR: [{ enrichment: null }, { enrichment: { category: null } }],
      },
    });
  }

  async categoryBreakdown(eventId: string): Promise<CategoryBreakdownRecord> {
    const live = { eventId, deletedAt: null, status: { in: [...LIVE_STATUSES] } };

    const [grouped, uncategorized, models, latest] = await Promise.all([
      this.prisma.questionEnrichment.groupBy({
        by: ['category'],
        where: { category: { not: null }, question: live },
        _count: { _all: true },
      }),
      this.countUncategorized(eventId),
      this.prisma.questionEnrichment.findMany({
        where: { category: { not: null }, modelId: { not: null }, question: live },
        select: { modelId: true },
        distinct: ['modelId'],
      }),
      this.prisma.questionEnrichment.aggregate({
        where: { category: { not: null }, question: live },
        _max: { computedAt: true },
      }),
    ]);

    const counts = grouped
      .filter((group) => group.category !== null)
      .map((group) => ({ category: group.category as string, questions: group._count._all }));

    return {
      counts,
      categorized: counts.reduce((sum, entry) => sum + entry.questions, 0),
      uncategorized,
      modelIds: models.flatMap((row) => (row.modelId ? [row.modelId] : [])),
      lastCategorizedAt: latest._max.computedAt,
    };
  }

  async findLive(eventId: string, limit: number): Promise<AiQuestionRecord[]> {
    const rows = await this.prisma.question.findMany({
      where: { eventId, deletedAt: null, status: { in: [...LIVE_STATUSES] } },
      select: QUESTION_SELECTION,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findSimilarityCandidates(
    eventId: string,
    questionId: string,
    normalizedBody: string,
    limit: number,
  ): Promise<MinimalQuestion[]> {
    // Tagged template: every value is a bound parameter, never SQL. Same
    // recall query the deterministic detector uses, so the model judges the
    // same candidates a moderator would have been shown.
    return this.prisma.$queryRaw<MinimalQuestion[]>`
      SELECT id, body, status
        FROM questions
       WHERE "eventId" = ${eventId}::uuid
         AND id <> ${questionId}::uuid
         AND "deletedAt" IS NULL
         AND status = ANY(${LIVE_STATUSES}::"QuestionStatus"[])
       ORDER BY similarity("normalizedBody", ${normalizedBody}) DESC
       LIMIT ${limit}
    `;
  }

  async storeCategories(
    assignments: ReadonlyArray<{ questionId: string; category: AiCategory }>,
    provenance: { modelId: string; promptVersion: string },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(
      assignments.map((assignment) =>
        this.prisma.questionEnrichment.upsert({
          where: { questionId: assignment.questionId },
          create: {
            questionId: assignment.questionId,
            status: 'COMPLETED',
            category: assignment.category,
            modelId: provenance.modelId,
            promptVersion: provenance.promptVersion,
            computedAt: now,
            attempts: 1,
          },
          update: {
            status: 'COMPLETED',
            category: assignment.category,
            modelId: provenance.modelId,
            promptVersion: provenance.promptVersion,
            computedAt: now,
            attempts: { increment: 1 },
            error: null,
          },
        }),
      ),
    );
  }

  async storeDuplicateSuggestion(
    questionId: string,
    suggestedQuestionId: string,
    confidence: number,
  ): Promise<void> {
    // Only where no suggestion stands: a moderator who already dismissed one
    // must not have it come back because a model agreed with the machine.
    await this.prisma.question.updateMany({
      where: { id: questionId, possibleDuplicateOfQuestionId: null, deletedAt: null },
      data: { possibleDuplicateOfQuestionId: suggestedQuestionId, duplicateSimilarity: confidence },
    });
  }

  async replaceTopics(
    eventId: string,
    topics: ReadonlyArray<{ label: string; summary: string; questionIds: string[] }>,
  ): Promise<TopicRecord[]> {
    return this.prisma.$transaction(async (tx) => {
      // Wholesale: clustering is a snapshot of the event, and stale topics
      // beside fresh ones would be two answers to one question.
      await tx.question.updateMany({ where: { eventId }, data: { topicId: null } });
      await tx.topic.deleteMany({ where: { eventId } });

      const created: TopicRecord[] = [];
      for (const topic of topics) {
        const row = await tx.topic.create({
          data: {
            eventId,
            label: topic.label,
            summary: topic.summary || null,
            questionCount: topic.questionIds.length,
          },
          select: { id: true, label: true, summary: true, createdAt: true },
        });
        // Scoped to the event: an id from another event cannot be re-pointed
        // even if the validator somehow let one through.
        await tx.question.updateMany({
          where: { id: { in: topic.questionIds }, eventId },
          data: { topicId: row.id },
        });
        created.push({ ...row, questionIds: topic.questionIds });
      }
      return created;
    });
  }

  async findTopics(eventId: string): Promise<TopicRecord[]> {
    const rows = await this.prisma.topic.findMany({
      where: { eventId },
      select: {
        id: true,
        label: true,
        summary: true,
        createdAt: true,
        questions: { where: { deletedAt: null }, select: { id: true } },
      },
      orderBy: { questionCount: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      summary: row.summary,
      questionIds: row.questions.map((question) => question.id),
      createdAt: row.createdAt,
    }));
  }

  async storeSuggestedAnswer(
    questionId: string,
    draft: { text: string; caveats: string[]; modelId: string; generatedAt: Date },
  ): Promise<void> {
    await this.prisma.questionEnrichment.upsert({
      where: { questionId },
      create: {
        questionId,
        status: 'COMPLETED',
        suggestedAnswer: draft.text,
        suggestedAnswerCaveats: draft.caveats,
        suggestedAnswerModelId: draft.modelId,
        suggestedAnswerAt: draft.generatedAt,
      },
      update: {
        suggestedAnswer: draft.text,
        suggestedAnswerCaveats: draft.caveats,
        suggestedAnswerModelId: draft.modelId,
        suggestedAnswerAt: draft.generatedAt,
      },
    });
  }

  async storeSummary(
    eventId: string,
    kind: 'LIVE' | 'FINAL',
    content: unknown,
    modelId: string,
  ): Promise<SummaryRecord> {
    const row = await this.prisma.eventSummary.create({
      data: { eventId, kind, content: content as object, modelId },
      select: { id: true, kind: true, content: true, modelId: true, generatedAt: true },
    });
    return { ...row, kind: row.kind as 'LIVE' | 'FINAL' };
  }

  async findLatestSummary(eventId: string): Promise<SummaryRecord | null> {
    const row = await this.prisma.eventSummary.findFirst({
      where: { eventId },
      orderBy: { generatedAt: 'desc' },
      select: { id: true, kind: true, content: true, modelId: true, generatedAt: true },
    });
    return row ? { ...row, kind: row.kind as 'LIVE' | 'FINAL' } : null;
  }

  // --- The ledger ----------------------------------------------------------

  async sumCostForEvent(eventId: string): Promise<number> {
    const result = await this.prisma.aiUsage.aggregate({
      where: { eventId },
      _sum: { costMicros: true },
    });
    return result._sum.costMicros ?? 0;
  }

  async sumCostSince(since: Date): Promise<number> {
    const result = await this.prisma.aiUsage.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { costMicros: true },
    });
    return result._sum.costMicros ?? 0;
  }

  async countCallsByFeature(eventId: string): Promise<Partial<Record<AiFeature, number>>> {
    const grouped = await this.prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { eventId },
      _count: { _all: true },
    });
    return Object.fromEntries(grouped.map((group) => [group.feature, group._count._all]));
  }

  async recordUsage(entry: UsageEntry): Promise<{ id: string }> {
    return this.prisma.aiUsage.create({
      data: {
        eventId: entry.eventId,
        feature: entry.feature,
        modelId: entry.modelId,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        cachedReadTokens: entry.cachedReadTokens,
        costMicros: entry.costMicros,
      },
      select: { id: true },
    });
  }

  async correctUsage(id: string, actual: Omit<UsageEntry, 'eventId' | 'feature'>): Promise<void> {
    await this.prisma.aiUsage.update({
      where: { id },
      data: {
        modelId: actual.modelId,
        tokensIn: actual.tokensIn,
        tokensOut: actual.tokensOut,
        cachedReadTokens: actual.cachedReadTokens,
        costMicros: actual.costMicros,
      },
    });
  }
}

interface QuestionRow {
  id: string;
  eventId: string;
  body: string;
  status: string;
  enrichment: { category: string | null } | null;
}

function toRecord(row: QuestionRow): AiQuestionRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    body: row.body,
    status: row.status as QuestionStatus,
    category: row.enrichment?.category ?? null,
  };
}
