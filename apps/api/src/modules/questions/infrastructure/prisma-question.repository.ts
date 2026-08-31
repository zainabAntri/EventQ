import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
// QuestionStatus is imported as a VALUE: `.options` is what zero-fills the
// status counts below without restating the list of statuses a third time.
import { computeRankScore, QuestionStatus, type QuestionSort } from '@eventq/contracts';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { DuplicateQuestionError, QuestionNotFoundError } from '../domain/question.errors';
import { ROOM_VISIBLE_STATUSES } from '../domain/question-lifecycle';
import {
  dateKey,
  decodeCursor,
  encodeCursor,
  numericKey,
  sortDefinition,
  type QuestionCursor,
  type SortDefinition,
} from '../domain/question-sort';
import type {
  AttendeeRecord,
  AttendeeRepository,
  CreateQuestionData,
  ModeratedQuestionRecord,
  QuestionPage,
  QuestionRecord,
  QuestionRepository,
  QuestionStatusCounts,
} from '../domain/question.repository';

/**
 * Prisma adapters for the question and attendee ports.
 *
 * Two guarantees are enforced HERE rather than being left to callers:
 *
 *   - every organizer-facing query carries `event: { orgId }` in its predicate,
 *     so a cross-organization row simply does not match even if a guard were
 *     bypassed or a use-case forgot to check;
 *   - the unique-constraint violation from a concurrent duplicate submission is
 *     translated into a domain error, so a race produces a clean 409 rather
 *     than a 500 with a Prisma stack trace.
 */

/**
 * pg_trgm similarity above which two questions are "probably the same".
 *
 * 0.6 is deliberately permissive: the consequence of a match is that a
 * moderator is asked to look, never that an attendee is refused. A stricter
 * value would miss real duplicates; a looser one would flag every question
 * about the same topic and make the signal worthless.
 */
const SIMILARITY_THRESHOLD = 0.6;

/** Statuses a new question could meaningfully duplicate. A rejected or spam
 *  question is not something a later one should be flagged against. */
const LIVE_STATUSES: readonly QuestionStatus[] = ['PENDING', 'APPROVED', 'ANSWERED'];

@Injectable()
export class PrismaAttendeeRepository implements AttendeeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(eventId: string, displayName: string | null): Promise<AttendeeRecord> {
    const attendee = await this.prisma.attendee.create({
      data: { eventId, displayName },
      select: ATTENDEE_SELECTION,
    });

    return attendee;
  }

  async findByIdForEvent(attendeeId: string, eventId: string): Promise<AttendeeRecord | null> {
    // eventId is part of the predicate, not checked afterwards in JavaScript.
    // A token minted for one event therefore cannot resolve an attendee row
    // belonging to another, even if its `sub` claim were somehow valid there.
    return this.prisma.attendee.findFirst({
      where: { id: attendeeId, eventId },
      select: ATTENDEE_SELECTION,
    });
  }

  async touch(attendeeId: string, displayName?: string | undefined): Promise<void> {
    await this.prisma.attendee.update({
      where: { id: attendeeId },
      data: {
        lastSeenAt: new Date(),
        // Only written when a name was actually supplied. Passing undefined
        // would be indistinguishable from "clear it" if this used null.
        ...(displayName ? { displayName } : {}),
      },
    });
  }
}

@Injectable()
export class PrismaQuestionRepository implements QuestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateQuestionData): Promise<QuestionRecord> {
    /**
     * One timestamp, used twice.
     *
     * `createdAt` is written explicitly rather than left to the column default
     * so that it and `rankScore` are derived from the SAME instant. Letting the
     * database stamp the row while the score was computed from a client-side
     * clock would put the two microscopically out of step — harmless for
     * ordering, but it would mean the score can never be recomputed from the
     * stored row and checked, which is exactly the assertion that keeps this
     * column honest.
     */
    const now = new Date();

    try {
      const question = await this.prisma.question.create({
        data: {
          eventId: data.eventId,
          attendeeId: data.attendeeId,
          body: data.body,
          normalizedBody: data.normalizedBody,
          bodyHash: data.bodyHash,
          status: data.status,
          isAnonymous: data.isAnonymous,
          idempotencyKey: data.idempotencyKey ?? null,
          createdAt: now,
          // Computed on write, never on read. See domain/question-sort.ts and
          // the ranking contract for why an accumulating score can be stored
          // safely and a decaying one cannot.
          rankScore: computeRankScore({
            upvoteCount: 0,
            createdAt: now,
            status: data.status,
            pinnedAt: null,
          }),
          // Why the system held this question, recorded in the immutable
          // moderation trail rather than on the question row. The audit table
          // already exists for exactly this, and a moderator needs the reason
          // far more often than any query needs to filter on it.
          ...(data.flags.length > 0 || data.possibleDuplicateOfQuestionId
            ? {
                moderationActions: {
                  create: {
                    actorType: 'SYSTEM',
                    action: 'auto_flag',
                    metadata: {
                      signals: data.flags,
                      possibleDuplicateOfQuestionId: data.possibleDuplicateOfQuestionId ?? null,
                    },
                  },
                },
              }
            : {}),
        },
        select: QUESTION_SELECTION,
      });

      return toQuestionRecord(question);
    } catch (error) {
      // P2002 is a unique-constraint violation. Reaching here means another
      // request committed the identical question (or the same idempotency key)
      // between our check and this insert — which is precisely the race the
      // index exists to settle. The database won; report it as a duplicate.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateQuestionError();
      }
      throw error;
    }
  }

  async findByIdempotencyKey(attendeeId: string, key: string): Promise<QuestionRecord | null> {
    const question = await this.prisma.question.findFirst({
      // Scoped to the attendee: two devices may generate the same key, and one
      // must never be handed the other's question.
      where: { attendeeId, idempotencyKey: key },
      select: QUESTION_SELECTION,
    });

    return question ? toQuestionRecord(question) : null;
  }

  async findByBodyHash(attendeeId: string, bodyHash: string): Promise<QuestionRecord | null> {
    const question = await this.prisma.question.findFirst({
      where: { attendeeId, bodyHash },
      select: QUESTION_SELECTION,
    });

    return question ? toQuestionRecord(question) : null;
  }

  async findSimilar(eventId: string, normalizedBody: string): Promise<{ id: string } | null> {
    // A TAGGED TEMPLATE, not $queryRawUnsafe. Every interpolation below becomes
    // a bound parameter, so attendee text is data and can never be parsed as
    // SQL. This is the one place in the module that writes SQL by hand, and it
    // is the single most important line in the file to get right.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
        FROM questions
       WHERE "eventId" = ${eventId}::uuid
         AND "deletedAt" IS NULL
         AND status = ANY(${LIVE_STATUSES}::"QuestionStatus"[])
         AND similarity("normalizedBody", ${normalizedBody}) > ${SIMILARITY_THRESHOLD}
       ORDER BY similarity("normalizedBody", ${normalizedBody}) DESC
       LIMIT 1
    `;

    return rows[0] ?? null;
  }

  async findVisibleForAttendee(input: {
    eventId: string;
    attendeeId: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<QuestionRecord & { isMine: boolean }>> {
    const rows = await this.prisma.question.findMany({
      where: {
        eventId: input.eventId,
        deletedAt: null,
        OR: [
          // What the room can see, taken from the domain rather than restated.
          // It was a hardcoded list here until a dead-code sweep found that
          // isVisibleToRoom was used only by its own test — two definitions of
          // one rule, and the query was the one that mattered.
          { status: { in: [...ROOM_VISIBLE_STATUSES] } },
          // Plus this attendee's own, whatever state they are in, so someone
          // can see that their question is waiting. Never anyone else's — that
          // would expose an unmoderated question to the room.
          { attendeeId: input.attendeeId },
        ],
      },
      select: QUESTION_SELECTION,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    // The attendee board keeps Phase 3's id cursor. It is sound here and only
    // here: the sort is fixed at createdAt DESC, and ids are UUID v7, so "after
    // this id" and "older than this row" describe the same set. The dashboard
    // cannot make that assumption because it can sort by rank or by votes.
    return toPage(
      rows,
      input.limit,
      (row) => ({ ...toQuestionRecord(row), isMine: row.attendeeId === input.attendeeId }),
      (row) => row.id,
    );
  }

  async findForModeration(input: {
    eventId: string;
    orgId: string;
    status?: QuestionStatus | undefined;
    search?: string | undefined;
    sort: QuestionSort;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<ModeratedQuestionRecord>> {
    const definition = sortDefinition(input.sort);
    const cursor = input.cursor ? decodeCursor(input.cursor, input.sort) : null;

    const rows = await this.prisma.question.findMany({
      where: {
        eventId: input.eventId,
        // Ownership enforced by the database, not by filtering afterwards.
        event: { orgId: input.orgId, deletedAt: null },
        /**
         * ARCHIVED is the soft-delete state, so an archived question carries a
         * `deletedAt` and is excluded from every ordinary read. Asking for it
         * BY NAME is the one way to see it — that is what makes the dashboard's
         * archive tab possible without weakening the default.
         */
        ...(input.status === 'ARCHIVED' ? {} : { deletedAt: null }),
        ...(input.status ? { status: input.status } : {}),
        /**
         * Search runs against the normalised body, so it rides the GIN trigram
         * index built for duplicate detection — no new index, no new
         * dependency, and nothing that costs anything per query.
         *
         * The term arrives already normalised, which incidentally removes every
         * LIKE metacharacter: normalisation keeps only letters, numbers and
         * single spaces, so a search for "50%" cannot turn into a wildcard.
         */
        ...(input.search ? { normalizedBody: { contains: input.search } } : {}),
        ...(cursor ? keysetPredicate(definition, cursor) : {}),
      },
      select: MODERATION_SELECTION,
      orderBy: orderByFor(definition),
      take: input.limit + 1,
    });

    return toPage(rows, input.limit, toModeratedRecord, (row) => encodeCursor(input.sort, row));
  }

  async countByStatusForOrg(eventId: string, orgId: string): Promise<QuestionStatusCounts> {
    /**
     * One grouped query for both jobs this endpoint does.
     *
     * Deliberately NOT filtered on `deletedAt`: the archive tab needs its own
     * badge, and the change token below must move when a question is archived —
     * which, if archived rows were excluded, would look identical to nothing
     * having happened at all.
     */
    const grouped = await this.prisma.question.groupBy({
      by: ['status'],
      where: { eventId, event: { orgId, deletedAt: null } },
      _count: { _all: true },
      _max: { updatedAt: true },
    });

    const counts = Object.fromEntries(QUESTION_STATUSES.map((status) => [status, 0])) as Record<
      QuestionStatus,
      number
    >;

    let lastChangedAt: Date | null = null;

    for (const group of grouped) {
      counts[group.status] = group._count._all;

      const changed = group._max.updatedAt;
      if (changed && (!lastChangedAt || changed > lastChangedAt)) lastChangedAt = changed;
    }

    return { counts, lastChangedAt };
  }

  async findByIdForOrg(questionId: string, orgId: string): Promise<ModeratedQuestionRecord | null> {
    const question = await this.prisma.question.findFirst({
      where: { id: questionId, event: { orgId, deletedAt: null }, deletedAt: null },
      select: MODERATION_SELECTION,
    });

    return question ? toModeratedRecord(question) : null;
  }

  async applyModeration(input: {
    questionId: string;
    orgId: string;
    status: QuestionStatus;
    actorId: string;
    action: string;
    reason?: string | undefined;
  }): Promise<ModeratedQuestionRecord> {
    return this.prisma.$transaction(async (tx) => {
      /**
       * Read before write, because the new rank score depends on columns this
       * update does not touch — the vote count, the creation time and whether
       * the question is pinned. Scoped identically to the update below, so a
       * question in another organization is invisible here too and never
       * reaches the point of being counted as "not found" for a different
       * reason.
       */
      const existing = await tx.question.findFirst({
        where: { id: input.questionId, event: { orgId: input.orgId }, deletedAt: null },
        select: { upvoteCount: true, createdAt: true, pinnedAt: true },
      });

      if (!existing) throw new QuestionNotFoundError();

      // updateMany rather than update: it accepts the relation predicate, so
      // the organization check is executed BY POSTGRES as part of the write.
      // A question in another organization matches nothing and updates nothing.
      const { count } = await tx.question.updateMany({
        where: { id: input.questionId, event: { orgId: input.orgId }, deletedAt: null },
        data: {
          status: input.status,
          // The status is a ranking input, so the stored score moves with it.
          // Recomputed rather than adjusted: there is one formula, and it is
          // the same one that wrote the value in the first place.
          rankScore: computeRankScore({
            upvoteCount: existing.upvoteCount,
            createdAt: existing.createdAt,
            status: input.status,
            pinnedAt: existing.pinnedAt,
          }),
          // Timestamps that belong to a state, kept in step with it.
          ...(input.status === 'ANSWERED' ? { answeredAt: new Date() } : {}),
          /**
           * Un-answering clears the timestamp. APPROVED is reachable from
           * PENDING (where it is already null, so this is a no-op) and from
           * ANSWERED, which is the case that matters: a question put back on
           * the board because the answer was wrong must not still report when
           * it was answered.
           */
          ...(input.status === 'APPROVED' ? { answeredAt: null } : {}),
          // ARCHIVED is the soft delete, so it must also leave every scoped read.
          ...(input.status === 'ARCHIVED' ? { deletedAt: new Date() } : {}),
        },
      });

      if (count === 0) throw new QuestionNotFoundError();

      // Appended in the SAME transaction as the change. A status change with no
      // audit row is unexplainable, and an audit row for a change that did not
      // commit is a lie — the trail is only trustworthy if these are atomic.
      await tx.moderationAction.create({
        data: {
          questionId: input.questionId,
          actorType: 'USER',
          actorId: input.actorId,
          action: input.action,
          reason: input.reason ?? null,
          metadata: {},
        },
      });

      const updated = await tx.question.findFirstOrThrow({
        where: { id: input.questionId },
        select: MODERATION_SELECTION,
      });

      return toModeratedRecord(updated);
    });
  }
}

/**
 * Every status, for zero-filling the counts.
 *
 * Read from the shared contract rather than restated, so a status added later
 * gets a tab and a badge automatically instead of silently counting as nothing.
 * The schema's enum is already asserted identical to this one by the drift test
 * in shared/prisma, so there is no third list to keep in step.
 */
const QUESTION_STATUSES: readonly QuestionStatus[] = QuestionStatus.options;

/**
 * Resumes an ordered scan immediately after a known row.
 *
 * The OR is a tuple comparison written the long way, because Prisma has no
 * syntax for `(column, id) < (value, id)`:
 *
 *   strictly past the boundary value           OR
 *   exactly on it, and strictly past its id
 *
 * The second branch is what makes ties safe. Without it, every row sharing the
 * boundary's score is either skipped or repeated — and questions tie constantly
 * on vote count, where the overwhelming majority sit at zero.
 */
function keysetPredicate(
  definition: SortDefinition,
  cursor: QuestionCursor,
): Prisma.QuestionWhereInput {
  const descending = definition.direction === 'desc';
  const idTiebreak = descending ? { id: { lt: cursor.id } } : { id: { gt: cursor.id } };

  switch (definition.column) {
    case 'rankScore': {
      const value = numericKey(cursor);
      return {
        OR: [
          { rankScore: descending ? { lt: value } : { gt: value } },
          { rankScore: value, ...idTiebreak },
        ],
      };
    }
    case 'upvoteCount': {
      const value = numericKey(cursor);
      return {
        OR: [
          { upvoteCount: descending ? { lt: value } : { gt: value } },
          { upvoteCount: value, ...idTiebreak },
        ],
      };
    }
    case 'createdAt': {
      const value = dateKey(cursor);
      return {
        OR: [
          { createdAt: descending ? { lt: value } : { gt: value } },
          { createdAt: value, ...idTiebreak },
        ],
      };
    }
  }
}

/** The id runs in the same direction as the column, so one keyset comparison
 *  covers the pair and the order is total. */
function orderByFor(definition: SortDefinition): Prisma.QuestionOrderByWithRelationInput[] {
  const { direction } = definition;

  switch (definition.column) {
    case 'rankScore':
      return [{ rankScore: direction }, { id: direction }];
    case 'upvoteCount':
      return [{ upvoteCount: direction }, { id: direction }];
    case 'createdAt':
      return [{ createdAt: direction }, { id: direction }];
  }
}

const ATTENDEE_SELECTION = {
  id: true,
  eventId: true,
  displayName: true,
  isBlocked: true,
} as const;

const QUESTION_SELECTION = {
  id: true,
  eventId: true,
  attendeeId: true,
  body: true,
  status: true,
  isAnonymous: true,
  upvoteCount: true,
  rankScore: true,
  pinnedAt: true,
  createdAt: true,
  updatedAt: true,
  answeredAt: true,
  attendee: { select: { displayName: true } },
} as const;

const MODERATION_SELECTION = {
  ...QUESTION_SELECTION,
  moderationActions: {
    where: { actorType: 'SYSTEM' as const, action: 'auto_flag' },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { metadata: true },
  },
  /**
   * A left join on a primary key, and null for every question until AI
   * enrichment is switched on — which is off by default and the only mode
   * currently shipped. Selected anyway so "category if available" is a field
   * the dashboard can render the moment anything writes it, rather than a
   * schema change made during a phase that is already about something else.
   */
  enrichment: { select: { category: true } },
} as const;

interface QuestionRow {
  id: string;
  eventId: string;
  attendeeId: string;
  body: string;
  status: string;
  isAnonymous: boolean;
  upvoteCount: number;
  rankScore: number;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  answeredAt: Date | null;
  attendee: { displayName: string | null } | null;
}

type ModerationRow = QuestionRow & {
  moderationActions: Array<{ metadata: unknown }>;
  enrichment: { category: string | null } | null;
};

/** Maps a row to the domain shape so no ORM type escapes this file. */
function toQuestionRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    attendeeId: row.attendeeId,
    body: row.body,
    status: row.status as QuestionStatus,
    isAnonymous: row.isAnonymous,
    upvoteCount: row.upvoteCount,
    rankScore: row.rankScore,
    pinnedAt: row.pinnedAt,
    authorName: row.attendee?.displayName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    answeredAt: row.answeredAt,
  };
}

function toModeratedRecord(row: ModerationRow): ModeratedQuestionRecord {
  const metadata = row.moderationActions[0]?.metadata;

  return {
    ...toQuestionRecord(row),
    flags: readSignals(metadata),
    possibleDuplicateOfQuestionId: readDuplicateId(metadata),
    category: row.enrichment?.category ?? null,
  };
}

/**
 * Json columns are `unknown` at the type level and genuinely arbitrary at
 * runtime, so both readers below validate rather than cast. A row written by an
 * older version of this code must degrade to "no flags", not crash a moderation
 * queue in the middle of a live event.
 */
function readSignals(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];

  const signals = (metadata as { signals?: unknown }).signals;
  return Array.isArray(signals) ? signals.filter((s): s is string => typeof s === 'string') : [];
}

function readDuplicateId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;

  const id = (metadata as { possibleDuplicateOfQuestionId?: unknown })
    .possibleDuplicateOfQuestionId;
  return typeof id === 'string' ? id : null;
}

/**
 * One extra row tells us whether another page exists without a second COUNT
 * over a table that only grows — and cursor pagination is what keeps a page
 * stable while the list mutates underneath a reader, which on a live question
 * board it constantly does.
 */
function toPage<TRow extends { id: string }, TOut>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => TOut,
  makeCursor: (row: TRow) => string,
): QuestionPage<TOut> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items: items.map(map),
    nextCursor: hasMore && last ? makeCursor(last) : null,
    hasMore,
  };
}
