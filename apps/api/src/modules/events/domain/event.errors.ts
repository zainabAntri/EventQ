import type { EventStatus } from '@eventq/contracts';
import {
  ConflictError,
  InvariantViolationError,
  NotFoundError,
} from '../../../shared/errors/domain-error';
import { allowedTransitions } from './event-lifecycle';

/**
 * Event failures.
 *
 * EventNotFoundError is the load-bearing one. It is thrown both when an event
 * genuinely does not exist AND when it belongs to a different organization,
 * deliberately producing an identical response. Returning 403 for the second
 * case would confirm that the id is real, letting an attacker enumerate other
 * organizations' events one guess at a time — the BOLA/IDOR failure mode.
 */
export class EventNotFoundError extends NotFoundError {
  override readonly code = 'EVENT_NOT_FOUND' as const;

  constructor() {
    super('Event not found.');
  }
}

export class InvalidEventTransitionError extends InvariantViolationError {
  constructor(from: EventStatus, to: EventStatus) {
    const allowed = allowedTransitions(from);
    super(
      'INVALID_EVENT_TRANSITION',
      allowed.length === 0
        ? `An event that is ${from} cannot change status.`
        : `Cannot move an event from ${from} to ${to}. Allowed: ${allowed.join(', ')}.`,
      { context: { from, to, allowed } },
    );
  }
}

/** Editing is refused once an event is closed or archived. */
export class EventNotEditableError extends InvariantViolationError {
  constructor(status: EventStatus) {
    super('INVALID_EVENT_TRANSITION', `An event that is ${status} can no longer be edited.`, {
      context: { status },
    });
  }
}

/** Unpublishing after people have participated would hide their contributions. */
export class EventHasParticipationError extends ConflictError {
  constructor(participantCount: number) {
    super(
      `This event already has ${participantCount} participant(s), so it cannot be returned to draft. Close it instead.`,
      { context: { participantCount } },
    );
  }
}

/**
 * The resulting date range would be invalid.
 *
 * Checked here rather than only in the request schema because a PATCH may move
 * the start date past an end date it never mentions — the payload alone is
 * consistent, the resulting event is not.
 */
export class InvalidEventDatesError extends InvariantViolationError {
  constructor() {
    super('VALIDATION_FAILED', 'The event must end after it starts.', {
      fieldErrors: [{ path: 'endsAt', message: 'The event must end after it starts.' }],
    });
  }
}

export class JoinCodeUnavailableError extends ConflictError {
  override readonly code = 'JOIN_CODE_TAKEN' as const;

  constructor() {
    super('Could not allocate a unique join code. Please try again.');
  }
}
