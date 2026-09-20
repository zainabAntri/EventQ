import type {
  AttendeeSessionResponse,
  PublicQuestionResponse,
  QuestionResponse,
  QuestionStatsResponse,
} from '@eventq/contracts';
import type {
  AttendeeRecord,
  ModeratedQuestionRecord,
  QuestionRecord,
  QuestionStatusCounts,
} from '../domain/question.repository';
import type { EventSubmissionPolicy } from '../domain/event-policy.port';
import { allowedActionsFor, statusVisibleToAuthor } from '../domain/question-lifecycle';
import { DUPLICATE_SUGGESTION_THRESHOLD } from '../domain/question-similarity';

/**
 * Record -> contract.
 *
 * Every response is built field by field rather than by spreading the record.
 * A spread would leak whatever the persistence layer happens to add next, which
 * is how internal columns end up on the public wire without anyone deciding to
 * put them there. On the attendee surface that is not a tidiness question —
 * `attendeeId`, `normalizedBody` and the moderation flags all live on the same
 * row and none of them may ever be seen by the room.
 */

/**
 * The attendee view.
 *
 * Two protections are applied here rather than being left to callers:
 *
 * 1. `authorName` is resolved against the event's identity policy AND the
 *    question's own anonymity flag. An ANONYMOUS event never attributes a
 *    question, whatever is stored on the row — so a name captured before an
 *    organizer switched the event to anonymous does not leak afterwards.
 *
 * 2. `status` goes through statusVisibleToAuthor, so a quarantined question is
 *    reported to its own author as PENDING and never as SPAM.
 */
export function toPublicQuestionResponse(
  record: QuestionRecord & { isMine: boolean; hasVoted: boolean },
  policy: Pick<EventSubmissionPolicy, 'attendeeIdentityMode'>,
): PublicQuestionResponse {
  const anonymous = record.isAnonymous || policy.attendeeIdentityMode === 'ANONYMOUS';

  return {
    id: record.id,
    body: record.body,
    status: statusVisibleToAuthor(record.status),
    authorName: anonymous ? null : record.authorName,
    isAnonymous: anonymous,
    upvoteCount: record.upvoteCount,
    askedByCount: record.askedByCount,
    isMine: record.isMine,
    hasVoted: record.hasVoted,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * The moderator view.
 *
 * Carries `flags` — why the system held this question — because a queue that
 * shows SPAM without saying why is one a moderator cannot act on with any
 * confidence. Still no `attendeeId`: identifying an attendee is a separate,
 * deliberate action (blocking), not something the queue hands out by default.
 */
export function toQuestionResponse(record: ModeratedQuestionRecord): QuestionResponse {
  return {
    id: record.id,
    eventId: record.eventId,
    body: record.body,
    // NOT passed through statusVisibleToAuthor: a moderator must see SPAM as
    // SPAM. Concealing it here would hide the queue they are meant to review.
    status: record.status,
    authorName: record.isAnonymous ? null : record.authorName,
    isAnonymous: record.isAnonymous,
    upvoteCount: record.upvoteCount,
    askedByCount: record.askedByCount,
    flags: record.flags,
    possibleDuplicate: record.possibleDuplicate
      ? {
          questionId: record.possibleDuplicate.questionId,
          body: record.possibleDuplicate.body,
          status: record.possibleDuplicate.status,
          upvoteCount: record.possibleDuplicate.upvoteCount,
          askedByCount: record.possibleDuplicate.askedByCount,
          // A suggestion raised before scores were recorded carries none. It
          // is reported at the threshold — "just similar enough to ask" — which
          // is exactly what the older detector meant by raising it at all.
          similarity: record.possibleDuplicate.similarity ?? DUPLICATE_SUGGESTION_THRESHOLD,
        }
      : null,
    mergedIntoQuestionId: record.mergedIntoQuestionId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    answeredAt: record.answeredAt?.toISOString() ?? null,
    rankScore: record.rankScore,
    pinnedAt: record.pinnedAt?.toISOString() ?? null,
    category: record.category,
    topic: record.topic,
    aiSuggestedAnswer: record.aiSuggestedAnswer
      ? {
          draft: record.aiSuggestedAnswer.draft,
          caveats: record.aiSuggestedAnswer.caveats,
          modelId: record.aiSuggestedAnswer.modelId,
          generatedAt: record.aiSuggestedAnswer.generatedAt.toISOString(),
        }
      : null,
    // Derived from the same transition table the moderation endpoint enforces,
    // so the dashboard renders exactly the buttons the API would accept.
    allowedActions: [...allowedActionsFor(record.status)],
  };
}

/**
 * Counts and a change token.
 *
 * `version` is built here rather than in the repository because it is a
 * transport concern: it exists so a client can compare two responses for
 * equality, and its format is deliberately not part of the contract.
 *
 * It combines the total row count with the newest `updatedAt`, which between
 * them move on every change a dashboard cares about — an insert lifts the
 * count, and any moderation decision, archive or restore lifts the timestamp.
 * Neither alone is sufficient: counts miss a status change, and a timestamp
 * misses nothing but is null on an empty event.
 */
export function toQuestionStatsResponse(counts: QuestionStatusCounts): QuestionStatsResponse {
  const values = Object.values(counts.counts);
  const total = values.reduce((sum, count) => sum + count, 0);

  return {
    counts: counts.counts,
    // ARCHIVED is the soft-deleted state and is excluded from the unfiltered
    // queue, so the headline figure must exclude it too or the tab would
    // promise rows the list does not return.
    total: total - (counts.counts.ARCHIVED ?? 0),
    version: `${total}:${counts.lastChangedAt?.getTime() ?? 0}`,
  };
}

/**
 * What a device gets on first scan.
 *
 * `limits` exists so the form can show an accurate counter immediately instead
 * of making a second call. It is a convenience for the UI and nothing more —
 * every number here is enforced again server-side on each submission.
 */
export function toAttendeeSessionResponse(
  attendee: AttendeeRecord,
  policy: EventSubmissionPolicy,
): AttendeeSessionResponse {
  return {
    attendeeId: attendee.id,
    displayName: attendee.displayName,
    identityMode: policy.attendeeIdentityMode,
    moderationMode: policy.moderationMode,
    allowUpvotes: policy.allowUpvotes,
    limits: {
      minQuestionLength: policy.minQuestionLength,
      maxQuestionLength: policy.maxQuestionLength,
      submitLimitCount: policy.submitLimitCount,
      submitLimitWindowSeconds: policy.submitLimitWindowSeconds,
    },
  };
}
