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
  /** Whether the organizer allows voting. The board hides its vote buttons
   *  when false; the server refuses the vote regardless. */
  allowUpvotes: z.boolean(),
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
  /**
   * Whether THIS attendee has voted for it.
   *
   * Sent with every list so the board renders the right state after a page
   * refresh without a second request — and so a refresh cannot be used to
   * "forget" a vote and cast it again: the server remembers either way.
   */
  hasVoted: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PublicQuestionResponse = z.infer<typeof PublicQuestionResponse>;

export const PublicQuestionListResponse = pageOf(PublicQuestionResponse);
export type PublicQuestionListResponse = z.infer<typeof PublicQuestionListResponse>;

/**
 * The state of one attendee's vote on one question, after a vote or unvote.
 *
 * Both endpoints return this same shape and both are IDEMPOTENT: `PUT …/vote`
 * means "make sure my vote exists" and `DELETE …/vote` means "make sure it
 * does not". Sending either twice is harmless and yields the same response,
 * which is what makes a double-tap, a retry on dropped wifi and a page refresh
 * all safe. There is no request body — the identity comes from the attendee
 * token and the question from the URL, and nothing else is the client's to say.
 */
export const VoteResponse = z.object({
  questionId: EntityId,
  upvoteCount: z.number().int().nonnegative(),
  hasVoted: z.boolean(),
});
export type VoteResponse = z.infer<typeof VoteResponse>;

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

/**
 * What the system found when it thought a question repeated an earlier one.
 *
 * `similarity` is 0–1 and is the max of two deterministic measures — character
 * trigrams and content-word overlap — computed at ZERO API cost. It is shown so
 * a moderator can weigh a 0.95 differently from a 0.62; a flat flag would make
 * every suggestion look equally confident, and they are not.
 */
export const DuplicateSuggestion = z.object({
  questionId: EntityId,
  body: z.string(),
  status: QuestionStatus,
  upvoteCount: z.number().int().nonnegative(),
  similarity: z.number().min(0).max(1),
});
export type DuplicateSuggestion = z.infer<typeof DuplicateSuggestion>;

/**
 * Confirming a duplicate: "this question repeats THAT one, fold it in".
 *
 * The question in the URL is the copy; `intoQuestionId` is the survivor. Sent
 * explicitly rather than taken from the stored suggestion, so a moderator can
 * merge into a question the system did not suggest — and so the server can
 * refuse a target that has itself been merged away, which is what prevents a
 * chain or a cycle from ever forming.
 */
export const MergeQuestionRequest = z.object({
  intoQuestionId: EntityId,
});
export type MergeQuestionRequest = z.infer<typeof MergeQuestionRequest>;

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
  /**
   * The question this one may be repeating, when the system found one.
   *
   * A SUGGESTION, not a decision: nothing is hidden, merged or deleted on the
   * strength of it. A moderator either confirms it (merge) or dismisses it, and
   * either way it stops being reported here. Carries the original's text so the
   * two can be compared on one card, without a second request per suggestion.
   */
  possibleDuplicate: DuplicateSuggestion.nullable(),
  /**
   * Set once a moderator confirmed this question repeats another. The question
   * is archived at that moment, so this is only ever seen on the archive tab —
   * where it explains WHY the question is there.
   */
  mergedIntoQuestionId: EntityId.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),

  /**
   * The value the server actually ordered by.
   *
   * Sent so a dashboard can justify the order it displays rather than asking a
   * moderator to take it on faith. The absolute number is meaningless on its
   * own — feed it and the fields above to `explainRankScore` for the four
   * components that produced it.
   */
  rankScore: z.number(),

  /** Organizer priority. Set by no endpoint yet; it is a ranking input the
   *  score already honours, ready for the projector view to drive. */
  pinnedAt: z.iso.datetime().nullable(),

  /**
   * AI-derived topic, when one exists.
   *
   * Null for every question until AI enrichment is switched on for the event —
   * which is off by default and the only mode currently shipped. A dashboard
   * therefore treats this as genuinely optional rather than as a field that is
   * temporarily broken.
   */
  category: z.string().nullable(),

  /**
   * The moderation actions legal from this question's CURRENT state.
   *
   * Computed server-side from the same transition table that enforces them, so
   * a dashboard cannot offer a button the API would refuse. The alternative —
   * shipping the transition table to the client — would be a second copy of a
   * rule that must never disagree with the first.
   */
  allowedActions: z.array(QuestionModerationAction),
});
export type QuestionResponse = z.infer<typeof QuestionResponse>;

export const ModerateQuestionRequest = z.object({
  action: QuestionModerationAction,
  /** Recorded in the immutable moderation audit trail. */
  reason: z.string().trim().max(500).optional(),
});
export type ModerateQuestionRequest = z.infer<typeof ModerateQuestionRequest>;

/**
 * How a moderation queue is ordered.
 *
 * `rank` is the default and is the only one that is not a raw column sort — see
 * ./ranking.ts for what it blends and why. The other three exist because a
 * moderator sometimes needs a mechanical order they can reason about: "oldest
 * first" is how you work a backlog without missing anyone, and "votes" answers
 * "what does the room most want asked" directly.
 */
export const QuestionSort = z.enum(['rank', 'newest', 'oldest', 'votes']);
export type QuestionSort = z.infer<typeof QuestionSort>;

/**
 * Shortest accepted search term.
 *
 * Two characters, because search runs against the pg_trgm index built for
 * duplicate detection and a term shorter than a trigram cannot use it — it
 * degrades to a full scan of the event's questions. Two is the point where the
 * cost is still trivial at the sizes this dashboard is specified for.
 */
export const QUESTION_SEARCH_MIN_LENGTH = 2;

/** The moderation queue. Cursor-paginated, because it mutates while it is read. */
export const ModerationQueueQuery = CursorPaginationQuery.extend({
  status: QuestionStatus.optional(),
  /**
   * Free-text search over the question body.
   *
   * Matched against the NORMALISED form — the same lossy, accent-stripped,
   * case-folded text that powers duplicate detection — so searching "cafe"
   * finds "Café" and searching "dont" finds "don't". A moderator hunting for a
   * question they half-remember should not have to reproduce its punctuation.
   */
  search: z.string().trim().min(QUESTION_SEARCH_MIN_LENGTH).max(200).optional(),
  sort: QuestionSort.default('rank'),
});
export type ModerationQueueQuery = z.infer<typeof ModerationQueueQuery>;

export const ModerationQueueResponse = pageOf(QuestionResponse);
export type ModerationQueueResponse = z.infer<typeof ModerationQueueResponse>;

/**
 * Question counts for one event, by status.
 *
 * Serves two purposes at once, which is the reason it exists as its own
 * endpoint rather than being folded into the queue response:
 *
 *   - it fills the count badges on the dashboard's status tabs, which would
 *     otherwise need one list request per tab;
 *   - `version` changes whenever anything in the event's questions changes, so
 *     a dashboard can poll THIS — a single grouped count over an indexed
 *     column — and re-run the expensive list query only when there is something
 *     new to show.
 *
 * That second use is what replaces a realtime transport here. See the endpoint
 * documentation for why SSE was not the right trade for this surface.
 */
export const QuestionStatsResponse = z.object({
  /** One entry per status, including zeros — so a client never has to
   *  distinguish "none" from "not reported". */
  counts: z.record(QuestionStatus, z.number().int().nonnegative()),
  /**
   * Questions the unfiltered queue will return: everything except ARCHIVED,
   * which is the soft-deleted state and is reachable only by asking for it.
   */
  total: z.number().int().nonnegative(),
  /**
   * Opaque change token.
   *
   * Derived from the row count and the newest `updatedAt`, so it moves on an
   * insert, on any status change and on an archive. Compare it for equality
   * only — its format is not part of this contract and will change.
   */
  version: z.string(),
});
export type QuestionStatsResponse = z.infer<typeof QuestionStatsResponse>;

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
