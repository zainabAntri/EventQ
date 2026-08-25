import { z } from 'zod';
import { CursorPaginationQuery, EntityId, pageOf } from './primitives.js';
import { AttendeeIdentityMode, ModerationMode, QuestionStatus } from './enums.js';

/**
 * Attendee participation contracts.
 *
 * The attendee surface is the hostile one: no account, no session a human chose
 * to create, and a URL printed on a poster in a public room. Every shape below
 * is written from that starting point.
 *
 * The write shapes carry ONLY what an attendee may set. `status`, `eventId`,
 * `attendeeId`, `upvoteCount` and every timestamp are absent by construction —
 * so "do not allow arbitrary status changes from the frontend" is not a rule
 * anyone has to remember, it is a shape nobody can express.
 */

/**
 * Hard ceiling on a submitted body, enforced by the schema before the request
 * reaches any handler.
 *
 * This is NOT the real limit. The limit an attendee actually sees comes from
 * their event (`EventSettings.minQuestionLength` / `maxQuestionLength`,
 * defaulting to 10 and 500) and is applied in the domain AFTER normalisation.
 * This constant exists purely so an oversized payload is rejected cheaply
 * rather than being normalised, hashed and compared first.
 */
export const QUESTION_BODY_HARD_MAX = 2_000;

/** Mirrors Attendee.displayName in the database. */
export const ATTENDEE_NAME_MAX = 120;

/**
 * Counts what a person would call a character.
 *
 * `String.length` counts UTF-16 code units, so an emoji costs two and a flag
 * costs four — a limit built on it rejects text that looks well inside it. This
 * lives in the shared contract so the counter under the textarea and the limit
 * the server enforces are the same function, not two implementations that agree
 * until they meet an unusual character.
 */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function countCharacters(text: string): number {
  let count = 0;
  for (const _segment of graphemes.segment(text)) count += 1;
  return count;
}

export const AttendeeDisplayName = z.string().trim().min(1).max(ATTENDEE_NAME_MAX);

/**
 * Submitting a question.
 *
 * `body` has no minimum here on purpose. The floor is per-event, so enforcing
 * one in the schema too would mean an empty body reports VALIDATION_FAILED
 * while a two-character body reports QUESTION_TOO_SHORT — two codes for one
 * situation. The domain owns the whole "too short" decision, and a client
 * branches on exactly one code.
 */
export const SubmitQuestionRequest = z.object({
  body: z.string().max(QUESTION_BODY_HARD_MAX, {
    error: 'That question is too long to send.',
  }),
  /**
   * Optional, always. An event whose identity mode is REQUIRED rejects a
   * submission without one; an ANONYMOUS event ignores it entirely. Neither
   * decision belongs to the client, so both live server-side.
   */
  displayName: AttendeeDisplayName.optional(),
  /** Attendee chose to hide their name on this one question. */
  isAnonymous: z.boolean().default(false),
});
export type SubmitQuestionRequest = z.infer<typeof SubmitQuestionRequest>;

/**
 * What a device gets on first scan.
 *
 * The token itself is NOT here — it is set as an httpOnly cookie, so no
 * JavaScript, including an injected payload, can read or copy it to another
 * device.
 *
 * `limits` is returned so the form can show an accurate counter and hint
 * immediately, without a second round trip. It is a convenience for the UI and
 * nothing more: the same numbers are enforced server-side on every submission.
 */
export const AttendeeSessionResponse = z.object({
  attendeeId: EntityId,
  displayName: z.string().nullable(),
  identityMode: AttendeeIdentityMode,
  moderationMode: ModerationMode,
  limits: z.object({
    minQuestionLength: z.number().int().nonnegative(),
    maxQuestionLength: z.number().int().positive(),
    submitLimitCount: z.number().int().positive(),
    submitLimitWindowSeconds: z.number().int().positive(),
  }),
});
export type AttendeeSessionResponse = z.infer<typeof AttendeeSessionResponse>;

/**
 * A question as an attendee sees it.
 *
 * Deliberately narrow rather than a filtered organizer shape: `attendeeId`,
 * `normalizedBody`, moderation flags and internal timestamps have no
 * representation here at all, so they cannot leak by someone forgetting to
 * strip them.
 *
 * `authorName` is null whenever the question is anonymous, whenever the event's
 * identity mode is ANONYMOUS, and whenever the attendee simply never gave one.
 * The three are indistinguishable to a reader, which is the point.
 */
export const PublicQuestionResponse = z.object({
  id: EntityId,
  body: z.string(),
  /**
   * Never SPAM. A quarantined question is reported to its own author as
   * PENDING — see the mapper for why.
   */
  status: QuestionStatus,
  authorName: z.string().nullable(),
  isAnonymous: z.boolean(),
  upvoteCount: z.number().int().nonnegative(),
  /** True for the caller's own question, so the UI can label it "yours". */
  isMine: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PublicQuestionResponse = z.infer<typeof PublicQuestionResponse>;

export const PublicQuestionListResponse = pageOf(PublicQuestionResponse);
export type PublicQuestionListResponse = z.infer<typeof PublicQuestionListResponse>;

/**
 * A question as a moderator sees it.
 *
 * Carries `flags` — the reasons the system routed this question to review or
 * quarantined it. A moderation queue that shows a question as SPAM without
 * saying why is one a moderator cannot act on with any confidence.
 */
export const QuestionResponse = z.object({
  id: EntityId,
  eventId: EntityId,
  body: z.string(),
  status: QuestionStatus,
  authorName: z.string().nullable(),
  isAnonymous: z.boolean(),
  upvoteCount: z.number().int().nonnegative(),
  /** Signal names from the spam heuristics, empty for a clean submission. */
  flags: z.array(z.string()),
  /** Set when the text closely resembles an existing question on this event. */
  possibleDuplicateOfQuestionId: EntityId.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
});
export type QuestionResponse = z.infer<typeof QuestionResponse>;

/**
 * Moderation is expressed as an ACTION, never as a target status.
 *
 * This is the concrete form of "the frontend cannot make arbitrary status
 * changes". A client cannot name a destination state at all: it names an
 * intent, and the server decides whether that intent is legal from the state
 * the question is actually in.
 */
export const QuestionModerationAction = z.enum([
  'approve',
  'reject',
  'spam',
  'answer',
  'archive',
  /** Undo a negative decision — returns the question to the queue, not to the room. */
  'restore',
]);
export type QuestionModerationAction = z.infer<typeof QuestionModerationAction>;

export const ModerateQuestionRequest = z.object({
  action: QuestionModerationAction,
  /** Recorded in the immutable moderation audit trail. */
  reason: z.string().trim().max(500).optional(),
});
export type ModerateQuestionRequest = z.infer<typeof ModerateQuestionRequest>;

/** The moderation queue. Cursor-paginated, because it mutates while it is read. */
export const ModerationQueueQuery = CursorPaginationQuery.extend({
  status: QuestionStatus.optional(),
});
export type ModerationQueueQuery = z.infer<typeof ModerationQueueQuery>;

export const ModerationQueueResponse = pageOf(QuestionResponse);
export type ModerationQueueResponse = z.infer<typeof ModerationQueueResponse>;

/**
 * Cookie carrying the attendee token.
 *
 * Already declared in the OpenAPI security scheme as `eq_pt`, so the name is
 * fixed by an existing published contract rather than chosen here.
 *
 * Scoped by PATH to one event's routes, which is what lets one device hold
 * separate identities at two concurrent events without them colliding — and it
 * matches the schema's decision that an Attendee row is event-scoped so the
 * same person at two events is deliberately two unlinkable rows.
 */
export const ATTENDEE_TOKEN_COOKIE = 'eq_pt';

/** Path a given event's attendee cookie is scoped to. */
export function attendeeCookiePath(joinCode: string): string {
  return `/api/v1/public/events/${joinCode}`;
}
