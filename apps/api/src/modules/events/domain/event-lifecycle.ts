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
 * What an unauthenticated visitor is allowed to learn from a join code.
 *
 * `'open'`   — the event page, accepting questions.
 * `'closed'` — the event took place and has finished. Readable, not writable.
 * `'hidden'` — an indistinguishable 404.
 *
 * ## Why `closed` is disclosed and the others are not
 *
 * Every state used to collapse into one 404 so that nobody could probe for
 * valid join codes. That protected a real thing, but it also meant a poster on
 * a wall became a dead end the moment the event ended, which is the most
 * common scan there is — people photograph the code and open it on the train
 * home.
 *
 * The disclosure is therefore narrowed to the case where the code was never a
 * secret in the first place. A PUBLISHED-then-CLOSED public event had its join
 * code displayed on a screen to a whole room and printed on posters; confirming
 * it existed tells an attacker nothing the venue did not already tell everyone
 * in it.
 *
 * The states that stay hidden are the ones where the code has *not* been
 * broadcast: a DRAFT nobody has seen, an ARCHIVED event past its retention, and
 * any PRIVATE event whose organizer explicitly chose that it not be findable.
 * `publishedAt` is required rather than inferred from the status, so an event
 * that somehow reached CLOSED without ever being published stays hidden too.
 *
 * Probing for valid codes is still answered by the rate limiter, which is where
 * that defence belongs — a 404 was never going to stop an attacker willing to
 * make 36^8 requests.
 */
export type PublicVisibility = 'open' | 'closed' | 'hidden';

export function publicVisibility(input: {
  status: EventStatus;
  accessMode: 'PUBLIC' | 'PRIVATE';
  publishedAt: Date | null;
}): PublicVisibility {
  if (input.accessMode !== 'PUBLIC') return 'hidden';
  if (input.status === 'PUBLISHED') return 'open';
  if (input.status === 'CLOSED' && input.publishedAt !== null) return 'closed';

  return 'hidden';
}

/**
 * Whether the event accepts new questions and votes.
 *
 * Separate from `publicVisibility` on purpose: a closed event is still
 * readable, and every write path must consult this rather than assuming that
 * "the attendee could load the page" implies "the attendee may post".
 */
export function acceptsParticipation(status: EventStatus): boolean {
  return status === 'PUBLISHED';
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
