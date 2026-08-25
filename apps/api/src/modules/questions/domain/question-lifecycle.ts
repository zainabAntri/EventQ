import type { ModerationMode, QuestionModerationAction, QuestionStatus } from '@eventq/contracts';
import type { SpamVerdict } from './spam-heuristics';

/**
 * Question lifecycle rules.
 *
 * Pure functions over plain data — no database, no clock, no framework — so
 * every rule is testable in microseconds and cannot be bypassed by a controller
 * that forgets to check something.
 *
 *   PENDING  ──▶ APPROVED | REJECTED | SPAM | ARCHIVED
 *   APPROVED ──▶ ANSWERED | REJECTED | ARCHIVED
 *   REJECTED ──▶ PENDING  | ARCHIVED
 *   SPAM     ──▶ PENDING  | ARCHIVED
 *   ANSWERED ──▶ APPROVED | ARCHIVED
 *   ARCHIVED ──▶ (nothing)
 *
 * Two things are worth noticing about that shape.
 *
 * First, undoing a negative decision returns a question to PENDING rather than
 * straight to APPROVED. A moderator restoring something they rejected by
 * mistake should put it back in the queue, not publish it to the room in one
 * click — the recovery path must not be a faster way to publish than the
 * ordinary one.
 *
 * Second, ARCHIVED is terminal. It is the soft-delete state, and a question
 * that could come back from it would reappear on a live board after someone
 * deliberately removed it.
 */
const TRANSITIONS: Readonly<Record<QuestionStatus, readonly QuestionStatus[]>> = Object.freeze({
  PENDING: ['APPROVED', 'REJECTED', 'SPAM', 'ARCHIVED'],
  APPROVED: ['ANSWERED', 'REJECTED', 'ARCHIVED'],
  REJECTED: ['PENDING', 'ARCHIVED'],
  SPAM: ['PENDING', 'ARCHIVED'],
  ANSWERED: ['APPROVED', 'ARCHIVED'],
  ARCHIVED: [],
});

/**
 * Moderator intent -> destination state.
 *
 * This indirection is the entire mechanism behind "the frontend cannot make
 * arbitrary status changes". A client names an ACTION; it has no way to name a
 * destination state at all. Whether that action is legal is then decided here,
 * from the state the question is actually in — not from anything the client
 * said about it.
 */
const ACTION_TARGET: Readonly<Record<QuestionModerationAction, QuestionStatus>> = Object.freeze({
  approve: 'APPROVED',
  reject: 'REJECTED',
  spam: 'SPAM',
  answer: 'ANSWERED',
  archive: 'ARCHIVED',
  restore: 'PENDING',
});

export function canTransition(from: QuestionStatus, to: QuestionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: QuestionStatus): readonly QuestionStatus[] {
  return TRANSITIONS[from];
}

/** The state a moderation action would move a question to. */
export function targetStatusFor(action: QuestionModerationAction): QuestionStatus {
  return ACTION_TARGET[action];
}

/**
 * The status a newly submitted question starts in.
 *
 * The spam verdict OVERRIDES the event's moderation mode, and only in the
 * stricter direction:
 *
 *   spam    -> SPAM     quarantined, never shown to the room
 *   review  -> PENDING  a human looks, even on a POST-moderated event
 *   clean   -> the event's own policy
 *
 * An organizer who chose POST moderation asked for questions to appear
 * immediately; they did not ask for a spam wave to appear immediately. The
 * override only ever adds friction, so it can never publish something the
 * organizer's own setting would have held back.
 *
 * Note what this function does NOT take: any client input. A submitted question
 * has no say in its own status, which is why the submit contract has no status
 * field to begin with.
 */
export function statusOnSubmission(mode: ModerationMode, verdict: SpamVerdict): QuestionStatus {
  if (verdict === 'spam') return 'SPAM';
  if (verdict === 'review') return 'PENDING';

  return mode === 'POST' ? 'APPROVED' : 'PENDING';
}

/**
 * Whether the room may see this question.
 *
 * ANSWERED counts: a question that has been answered on stage stays on the
 * board, otherwise it vanishes at the moment it becomes most useful.
 */
export const ROOM_VISIBLE_STATUSES: readonly QuestionStatus[] = Object.freeze([
  'APPROVED',
  'ANSWERED',
]);

export function isVisibleToRoom(status: QuestionStatus): boolean {
  return ROOM_VISIBLE_STATUSES.includes(status);
}

/**
 * What an attendee is told about their OWN question.
 *
 * SPAM is reported as PENDING. This is deliberate and is the one place the API
 * does not tell the whole truth.
 *
 * Telling a spammer they were caught lets them iterate against the filter until
 * they are not — the detector becomes a free oracle, and a public endpoint with
 * no account behind it cannot afford to hand one out. Reporting "waiting for a
 * moderator" is also what a false positive genuinely is: the `review` tier
 * absorbs anything uncertain, and SPAM -> PENDING exists so a moderator can
 * release a mistake.
 *
 * The cost is real and worth stating plainly: a wrongly-quarantined attendee
 * waits without knowing why. That is why the threshold for SPAM is set where a
 * single ordinary signal cannot reach it.
 */
export function statusVisibleToAuthor(status: QuestionStatus): QuestionStatus {
  return status === 'SPAM' ? 'PENDING' : status;
}
