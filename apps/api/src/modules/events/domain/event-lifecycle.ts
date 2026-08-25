import type { EventStatus } from '@eventq/contracts';

/**
 * Event lifecycle rules.
 *
 * Pure functions over plain data — no database, no clock, no framework — so
 * every rule below is testable in microseconds and cannot be accidentally
 * bypassed by a controller that forgets to check something.
 *
 *   DRAFT ──publish──▶ PUBLISHED ──close──▶ CLOSED
 *     ▲                    │                   │
 *     └────unpublish───────┘                   │
 *     └──────────────archive───────────────────┴──▶ ARCHIVED
 */

const TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = Object.freeze({
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'CLOSED', 'ARCHIVED'],
  // Terminal apart from deletion. Reopening a closed event would let questions
  // arrive after attendees were told it had finished; organizers who need that
  // duplicate the event instead.
  CLOSED: ['ARCHIVED'],
  // Soft-deleted. Nothing leaves this state.
  ARCHIVED: [],
});

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: EventStatus): readonly EventStatus[] {
  return TRANSITIONS[from];
}

/**
 * Whether an unauthenticated visitor may see this event through its public
 * identifier. Only PUBLISHED qualifies: a draft is unfinished and a closed
 * event should stop accepting traffic.
 */
export function isPubliclyVisible(status: EventStatus, accessMode: 'PUBLIC' | 'PRIVATE'): boolean {
  return status === 'PUBLISHED' && accessMode === 'PUBLIC';
}

/** Editable content is frozen once an event closes, so the record of what took
 *  place cannot be rewritten afterwards. */
export function isEditable(status: EventStatus): boolean {
  return status === 'DRAFT' || status === 'PUBLISHED';
}

/**
 * Unpublishing is only safe while nobody could have acted on the event yet.
 *
 * Once attendees have participated, pulling the event back to DRAFT would hide
 * their contributions and make the public link break for people who already
 * have it. Closing is the correct action then, and it is the one offered.
 */
export function canUnpublish(status: EventStatus, participantCount: number): boolean {
  return status === 'PUBLISHED' && participantCount === 0;
}

export type DeletionOutcome = 'deleted' | 'archived';

/**
 * Safe deletion.
 *
 * A hard delete is permitted ONLY for a draft that nobody has interacted with —
 * there is no history to lose, and an organizer who created an event by mistake
 * should be able to remove it completely.
 *
 * Anything that was ever published, or that has any participation, is ARCHIVED
 * instead. Cascading a real delete would silently destroy attendee
 * contributions and the audit trail of a real event, which is not something an
 * organizer can meaningfully consent to from a confirmation dialog.
 */
export function resolveDeletion(input: {
  status: EventStatus;
  publishedAt: Date | null;
  participantCount: number;
}): DeletionOutcome {
  const neverPublished = input.publishedAt === null && input.status === 'DRAFT';
  const untouched = input.participantCount === 0;

  return neverPublished && untouched ? 'deleted' : 'archived';
}
