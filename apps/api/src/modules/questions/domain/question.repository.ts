import type { QuestionSort, QuestionStatus } from '@eventq/contracts';

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
  /** The stored ordering value. Every ranked read and every cursor uses it. */
  rankScore: number;
  /** Organizer priority, a ranking input. No endpoint sets it yet. */
  pinnedAt: Date | null;
}

/** A question plus the moderation context only an organizer may see. */
export interface ModeratedQuestionRecord extends QuestionRecord {
  /** Signal names from the spam heuristics; empty for a clean submission. */
  flags: string[];
  possibleDuplicateOfQuestionId: string | null;
  /** AI-derived topic. Null unless enrichment has run, which requires AI to be
   *  switched on for the event — off by default and the only mode shipped. */
  category: string | null;
}

/** Question counts for one event, by status. Powers the dashboard's tab badges
 *  and its change detection in a single grouped query. */
export interface QuestionStatusCounts {
  counts: Record<QuestionStatus, number>;
  /** Newest `updatedAt` across every question on the event, or null when there
   *  are none. Combined with the counts, this moves on any insert, any status
   *  change and any archive — which is exactly what a poller needs. */
  lastChangedAt: Date | null;
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

  /**
   * The moderation queue. org-scoped, so another organization's event returns
   * an empty page rather than its contents.
   *
   * `search` matches the normalised body, and normalisation is the CALLER's
   * job — the repository must not know how question text is folded, or there
   * would be two implementations of it and searches would stop matching what
   * duplicate detection stored.
   */
  findForModeration(input: {
    eventId: string;
    orgId: string;
    status?: QuestionStatus | undefined;
    /** Already normalised for comparison. */
    search?: string | undefined;
    sort: QuestionSort;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<ModeratedQuestionRecord>>;

  /** Counts every status for one event, org-scoped like every other read here. */
  countByStatusForOrg(eventId: string, orgId: string): Promise<QuestionStatusCounts>;

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
