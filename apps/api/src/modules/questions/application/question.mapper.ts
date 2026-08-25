import type {
  AttendeeSessionResponse,
  PublicQuestionResponse,
  QuestionResponse,
} from '@eventq/contracts';
import type {
  AttendeeRecord,
  ModeratedQuestionRecord,
  QuestionRecord,
} from '../domain/question.repository';
import type { EventSubmissionPolicy } from '../domain/event-policy.port';
import { statusVisibleToAuthor } from '../domain/question-lifecycle';

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
  record: QuestionRecord & { isMine: boolean },
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
    isMine: record.isMine,
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
    flags: record.flags,
    possibleDuplicateOfQuestionId: record.possibleDuplicateOfQuestionId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    answeredAt: record.answeredAt?.toISOString() ?? null,
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
    limits: {
      minQuestionLength: policy.minQuestionLength,
      maxQuestionLength: policy.maxQuestionLength,
      submitLimitCount: policy.submitLimitCount,
      submitLimitWindowSeconds: policy.submitLimitWindowSeconds,
    },
  };
}
