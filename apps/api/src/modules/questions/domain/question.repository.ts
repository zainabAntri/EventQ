import type { QuestionStatus } from '@eventq/contracts';

/**
 * Port: question and attendee persistence.
 *
 * Note the shape of every organizer-facing method: `orgId` is a REQUIRED
 * parameter, never an optional filter — the same discipline EventRepository
 * uses. An unscoped read is not expressible, so "remember to check ownership"
 * becomes something the compiler enforces rather than something review has to
 * catch.
 *
 * Attendee-facing methods scope by `eventId` instead, taken from the attendee's
 * token, never from the request body.
 */

export interface AttendeeRecord {
  id: string;
  eventId: string;
  displayName: string | null;
  isBlocked: boolean;
}

export interface QuestionRecord {
  id: string;
  eventId: string;
  attendeeId: string;
  body: string;
  status: QuestionStatus;
  isAnonymous: boolean;
  upvoteCount: number;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
  answeredAt: Date | null;
}

/** A question plus the moderation context only an organizer may see. */
export interface ModeratedQuestionRecord extends QuestionRecord {
  /** Signal names from the spam heuristics; empty for a clean submission. */
  flags: string[];
  possibleDuplicateOfQuestionId: string | null;
}

export interface CreateQuestionData {
  eventId: string;
  attendeeId: string;
  body: string;
  normalizedBody: string;
  bodyHash: string;
  status: QuestionStatus;
  isAnonymous: boolean;
  idempotencyKey?: string | undefined;
  /** Written to the moderation audit trail as a SYSTEM action when non-empty,
   *  so a moderator can see why a question was held. */
  flags: string[];
  possibleDuplicateOfQuestionId?: string | undefined;
}

export interface QuestionPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AttendeeRepository {
  /** Creates a pseudonymous, event-scoped identity. No PII is required. */
  create(eventId: string, displayName: string | null): Promise<AttendeeRecord>;

  /** Scoped to the event, so a token for one event cannot resolve an attendee
   *  belonging to another. */
  findByIdForEvent(attendeeId: string, eventId: string): Promise<AttendeeRecord | null>;

  /** Records activity and, when supplied, a name the attendee has now given. */
  touch(attendeeId: string, displayName?: string | undefined): Promise<void>;
}

export interface QuestionRepository {
  create(data: CreateQuestionData): Promise<QuestionRecord>;

  /**
   * Looks up a previous submission with the same idempotency key.
   *
   * Scoped to the attendee: two people may legitimately generate the same key,
   * and one must never be handed the other's question.
   */
  findByIdempotencyKey(attendeeId: string, key: string): Promise<QuestionRecord | null>;

  /** Exact-duplicate check. The unique index is what settles a concurrent race;
   *  this exists so the common case returns a clean error without one. */
  findByBodyHash(attendeeId: string, bodyHash: string): Promise<QuestionRecord | null>;

  /**
   * Near-duplicate detection via pg_trgm similarity.
   *
   * Runs on our own Postgres at zero API cost — which is why this works with AI
   * disabled, the default and only mode currently shipped. Returns the closest
   * existing question above the similarity threshold, or null.
   */
  findSimilar(eventId: string, normalizedBody: string): Promise<{ id: string } | null>;

  /** The attendee's own view: everything visible to the room, plus their own
   *  not-yet-approved questions and nobody else's. */
  findVisibleForAttendee(input: {
    eventId: string;
    attendeeId: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<QuestionRecord & { isMine: boolean }>>;

  /** The moderation queue. org-scoped, so another organization's event returns
   *  an empty page rather than its contents. */
  findForModeration(input: {
    eventId: string;
    orgId: string;
    status?: QuestionStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<ModeratedQuestionRecord>>;

  findByIdForOrg(questionId: string, orgId: string): Promise<ModeratedQuestionRecord | null>;

  /**
   * Applies a moderation decision and appends its audit row in ONE transaction.
   *
   * Both or neither: a status change with no audit trail is unexplainable, and
   * an audit row for a change that did not happen is a lie. The immutable
   * ModerationAction table is only trustworthy if this is atomic.
   */
  applyModeration(input: {
    questionId: string;
    orgId: string;
    status: QuestionStatus;
    actorId: string;
    action: string;
    reason?: string | undefined;
  }): Promise<ModeratedQuestionRecord>;
}

export const QUESTION_REPOSITORY = Symbol('QUESTION_REPOSITORY');
export const ATTENDEE_REPOSITORY = Symbol('ATTENDEE_REPOSITORY');
