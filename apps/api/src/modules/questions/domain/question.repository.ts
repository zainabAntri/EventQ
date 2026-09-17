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

/**
 * The question a newer one may be repeating, with enough of it to compare the
 * two side by side on one card.
 */
export interface DuplicateSuggestionRecord {
  questionId: string;
  body: string;
  status: QuestionStatus;
  upvoteCount: number;
  /** 0–1. Null only for suggestions raised before a score was recorded. */
  similarity: number | null;
}

/** A question plus the moderation context only an organizer may see. */
export interface ModeratedQuestionRecord extends QuestionRecord {
  /** Signal names from the spam heuristics; empty for a clean submission. */
  flags: string[];
  /** A suggestion awaiting a moderator's confirmation or dismissal. */
  possibleDuplicate: DuplicateSuggestionRecord | null;
  /** Set once a moderator confirmed this question repeats another. */
  mergedIntoQuestionId: string | null;
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
  /** The closest existing question, when one cleared the similarity threshold. */
  possibleDuplicate?: { questionId: string; similarity: number } | undefined;
}

/** A candidate for duplicate detection, scored by the database on trigrams. */
export interface SimilarityCandidateRecord {
  id: string;
  normalizedBody: string;
  trigramSimilarity: number;
}

/** The state of one attendee's vote after a vote or unvote. */
export interface VoteOutcome {
  questionId: string;
  upvoteCount: number;
  hasVoted: boolean;
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
   * Candidate recall for duplicate detection: the live questions on this event
   * that share the most character trigrams with the new text.
   *
   * Runs on our own Postgres at zero API cost — which is why this works with AI
   * disabled, the default and only mode currently shipped. The recall bar is
   * deliberately LOW and the list short: the precise decision is made by the
   * domain (question-similarity.ts), which also weighs the words, and this only
   * has to make sure a reworded question is in the list at all.
   */
  findSimilarityCandidates(
    eventId: string,
    normalizedBody: string,
    limit: number,
  ): Promise<SimilarityCandidateRecord[]>;

  /** The attendee's own view: everything visible to the room, plus their own
   *  not-yet-approved questions and nobody else's. hasVoted is THIS
   *  attendee's, so a refreshed page renders the right button state. */
  findVisibleForAttendee(input: {
    eventId: string;
    attendeeId: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<QuestionPage<QuestionRecord & { isMine: boolean; hasVoted: boolean }>>;

  /**
   * Records an upvote, atomically with the counter and the score.
   *
   * Idempotent: an attendee who has already voted gets the current state back
   * and nothing changes. Concurrent votes on one question are serialised by a
   * row lock so the denormalised count can never drift from the vote rows.
   *
   * Returns null when the question is not one the room may vote on — absent,
   * on another event, archived, or not visible to the room — and the caller
   * reports that as not found, so an unpublished question cannot be probed.
   */
  castVote(input: {
    questionId: string;
    eventId: string;
    attendeeId: string;
  }): Promise<VoteOutcome | null>;

  /** The inverse of castVote, with the same idempotency and the same null. */
  withdrawVote(input: {
    questionId: string;
    eventId: string;
    attendeeId: string;
  }): Promise<VoteOutcome | null>;

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

  /**
   * Confirms a duplicate: archives questionId and moves its votes onto
   * intoQuestionId, all in one transaction.
   *
   * Votes transfer EXACTLY ONCE. An attendee who voted for both keeps one vote
   * on the survivor, not two — the unique index decides, not application code.
   * The survivor's count and score are recomputed from its vote rows afterwards
   * rather than incremented, so a concurrent live vote cannot leave the counter
   * off by one.
   *
   * The caller validates the pair (same event, not self, target not itself
   * merged); the transaction re-checks the target under a lock, because an
   * organizer could merge the target away between the read and this write.
   */
  mergeQuestion(input: {
    questionId: string;
    intoQuestionId: string;
    orgId: string;
    actorId: string;
  }): Promise<ModeratedQuestionRecord>;

  /**
   * Withdraws a duplicate suggestion — "no, these are different questions".
   *
   * Clears the suggestion and appends an audit row in one transaction, so the
   * trail shows both that the system raised it and that a person overruled it.
   */
  dismissDuplicate(input: {
    questionId: string;
    orgId: string;
    actorId: string;
  }): Promise<ModeratedQuestionRecord>;
}

export const QUESTION_REPOSITORY = Symbol('QUESTION_REPOSITORY');
export const ATTENDEE_REPOSITORY = Symbol('ATTENDEE_REPOSITORY');
