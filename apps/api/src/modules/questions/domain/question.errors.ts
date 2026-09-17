import type { EventStatus, QuestionStatus } from '@eventq/contracts';
import {
  ConflictError,
  ForbiddenError,
  InvariantViolationError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../../shared/errors/domain-error';
import { allowedTransitions } from './question-lifecycle';

/**
 * Question failures.
 *
 * Each carries a stable machine-readable code, so a client branches on `code`
 * and never on wording. The global exception filter turns these into RFC 9457
 * problem+json; nothing here knows about HTTP.
 */

/**
 * Reported both for a question that does not exist AND for one belonging to
 * another organization — deliberately indistinguishable, for the same reason
 * EventNotFoundError is. A 403 would confirm the id is real and turn the
 * endpoint into an oracle for enumerating other organizations' content.
 */
export class QuestionNotFoundError extends NotFoundError {
  constructor() {
    super('Question not found.');
  }
}

/**
 * The event is not accepting questions.
 *
 * Used only once the caller has already proved they hold a valid attendee token
 * for this event, so it reveals nothing they did not already know. An
 * unauthenticated probe for a draft or private event gets a flat 404 from the
 * public lookup instead — that distinction is the whole anti-enumeration story.
 */
export class EventNotAcceptingQuestionsError extends InvariantViolationError {
  constructor(status: EventStatus) {
    super(
      'EVENT_NOT_LIVE',
      status === 'CLOSED'
        ? 'This event has finished and is no longer taking questions.'
        : 'This event is not currently taking questions.',
      { context: { status } },
    );
  }
}

export class QuestionTooShortError extends InvariantViolationError {
  constructor(minimum: number, actual: number) {
    super('QUESTION_TOO_SHORT', `A question must be at least ${minimum} characters.`, {
      fieldErrors: [
        { path: 'body', message: `A question must be at least ${minimum} characters.` },
      ],
      context: { minimum, actual },
    });
  }
}

export class QuestionTooLongError extends InvariantViolationError {
  constructor(maximum: number, actual: number) {
    super('QUESTION_TOO_LONG', `A question must be at most ${maximum} characters.`, {
      fieldErrors: [{ path: 'body', message: `A question must be at most ${maximum} characters.` }],
      context: { maximum, actual },
    });
  }
}

/**
 * This attendee already asked this exact question.
 *
 * Raised both by the pre-check and by catching the database's unique-constraint
 * violation, because only the latter wins a race between two simultaneous
 * identical submissions.
 */
export class DuplicateQuestionError extends ConflictError {
  override readonly code = 'DUPLICATE_QUESTION' as const;

  constructor() {
    super('You have already asked this question.');
  }
}

/** The per-attendee submission window from EventSettings is exhausted. */
export class SubmissionLimitReachedError extends RateLimitedError {
  override readonly code = 'SUBMISSION_LIMIT_REACHED' as const;

  constructor(retryAfterSeconds: number, limit: number) {
    super(
      `You have reached the limit of ${limit} questions for now. Please wait a moment before asking another.`,
      retryAfterSeconds,
      { context: { limit } },
    );
  }
}

/**
 * A moderator blocked this attendee.
 *
 * 403 rather than a silent success: unlike spam quarantine, being blocked is a
 * deliberate human decision about a specific person, and leaving them typing
 * into a void would be worse than telling them.
 */
export class AttendeeBlockedError extends ForbiddenError {
  override readonly code = 'ATTENDEE_BLOCKED' as const;

  constructor() {
    super('You are no longer able to post questions at this event.');
  }
}

/** The event's identity mode is REQUIRED and no display name was given. */
export class IdentityRequiredError extends InvariantViolationError {
  constructor() {
    super('IDENTITY_REQUIRED', 'This event requires you to give your name before asking.', {
      fieldErrors: [{ path: 'displayName', message: 'Please enter your name.' }],
    });
  }
}

/** The requested moderation action is not legal from the question's current state. */
export class InvalidQuestionTransitionError extends InvariantViolationError {
  constructor(from: QuestionStatus, to: QuestionStatus) {
    const allowed = allowedTransitions(from);
    super(
      'INVALID_QUESTION_TRANSITION',
      allowed.length === 0
        ? `A question that is ${from} can no longer change status.`
        : `Cannot move a question from ${from} to ${to}. Allowed: ${allowed.join(', ')}.`,
      { context: { from, to, allowed } },
    );
  }
}

/**
 * The organizer switched voting off for this event.
 *
 * 422 rather than 403: the attendee is perfectly entitled to be here, it is the
 * operation that the event does not offer. Safe to say plainly, because the
 * board already hides its vote buttons when this is the case — only a
 * hand-crafted request reaches it.
 */
export class VotingDisabledError extends InvariantViolationError {
  constructor() {
    super('VOTING_DISABLED', 'Voting is switched off for this event.');
  }
}

/** A question cannot absorb itself. */
export class CannotMergeIntoSelfError extends InvariantViolationError {
  constructor() {
    super('CANNOT_MERGE_INTO_SELF', 'A question cannot be merged into itself.');
  }
}

/**
 * The chosen survivor cannot take a merge.
 *
 * Covers a target that was itself merged away (which is how a chain, and
 * therefore a cycle, is prevented), one that is archived, rejected or spam, and
 * one on a different event. The reason is given, because a moderator picked
 * this target deliberately and "no" without a why sends them guessing.
 */
export class InvalidMergeTargetError extends InvariantViolationError {
  constructor(reason: 'merged' | 'not_live' | 'different_event') {
    super(
      'INVALID_MERGE_TARGET',
      reason === 'merged'
        ? 'That question has already been merged into another. Merge into the surviving question instead.'
        : reason === 'different_event'
          ? 'Questions can only be merged within the same event.'
          : 'Only a question that is waiting, approved or answered can absorb another.',
      { context: { reason } },
    );
  }
}

/**
 * No usable attendee token.
 *
 * Missing, expired, malformed and issued-for-a-different-event all produce this
 * one error, so a token cannot be probed to learn which events exist.
 */
export class AttendeeSessionRequiredError extends UnauthenticatedError {
  constructor() {
    super('Join this event before asking a question.');
  }
}
