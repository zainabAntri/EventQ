import { Inject, Injectable } from '@nestjs/common';
import type {
  AttendeeSessionResponse,
  CursorPaginationQuery,
  ModerateQuestionRequest,
  ModerationQueueQuery,
  ModerationQueueResponse,
  PublicQuestionListResponse,
  PublicQuestionResponse,
  QuestionResponse,
  QuestionStatsResponse,
  SubmitQuestionRequest,
} from '@eventq/contracts';
// Pure domain rules from the events module. Imported rather than restated:
// duplicating "which events are publicly reachable" is how two answers to one
// question eventually disagree, and this is the answer an attacker probes.
import { isPubliclyVisible } from '../../events/domain/event-lifecycle';
import { EventNotFoundError } from '../../events/domain/event.errors';
import type { RequestContext } from '../../../shared/auth/request-context';
import { RATE_LIMITER, type RateLimiter } from '../../../shared/rate-limit/rate-limiter.port';
import {
  ATTENDEE_REPOSITORY,
  QUESTION_REPOSITORY,
  type AttendeeRecord,
  type AttendeeRepository,
  type QuestionRepository,
} from '../domain/question.repository';
import {
  EVENT_POLICY_READER,
  type EventPolicyReader,
  type EventSubmissionPolicy,
} from '../domain/event-policy.port';
import {
  ATTENDEE_TOKENS,
  type AttendeeTokenClaims,
  type AttendeeTokens,
} from '../domain/attendee-tokens.port';
import {
  normalizeDisplayName,
  normalizeForComparison,
  normalizeQuestion,
} from '../domain/question-text';
import { assessForSpam } from '../domain/spam-heuristics';
import { canTransition, statusOnSubmission, targetStatusFor } from '../domain/question-lifecycle';
import {
  AttendeeBlockedError,
  AttendeeSessionRequiredError,
  DuplicateQuestionError,
  EventNotAcceptingQuestionsError,
  IdentityRequiredError,
  InvalidQuestionTransitionError,
  QuestionNotFoundError,
  QuestionTooLongError,
  QuestionTooShortError,
  SubmissionLimitReachedError,
} from '../domain/question.errors';
import {
  toAttendeeSessionResponse,
  toPublicQuestionResponse,
  toQuestionResponse,
  toQuestionStatsResponse,
} from './question.mapper';

/**
 * Attendee-facing use-cases take the event id from the ATTENDEE TOKEN, never
 * from the request body. Organizer-facing ones take the organization from the
 * session, never from a path or payload. Both are the same rule: the identity a
 * caller acts under is derived from what they proved, not from what they said.
 */

/**
 * First scan.
 *
 * Creates the pseudonymous, event-scoped identity described in the schema. No
 * account, no password, no personal data required — which is the entire point
 * of the product's "no signup" promise, and also what keeps GDPR simple.
 */
@Injectable()
export class JoinEventUseCase {
  constructor(
    @Inject(EVENT_POLICY_READER) private readonly policies: EventPolicyReader,
    @Inject(ATTENDEE_REPOSITORY) private readonly attendees: AttendeeRepository,
    @Inject(ATTENDEE_TOKENS) private readonly tokens: AttendeeTokens,
  ) {}

  async execute(
    joinCode: string,
    existingAttendeeId: string | null,
  ): Promise<{ session: AttendeeSessionResponse; token: string }> {
    const policy = await this.requireJoinableEvent(joinCode);

    // Reuse the identity this device already holds for THIS event rather than
    // minting a second one. Otherwise a page refresh would create a fresh
    // attendee with a fresh submission quota, which is a trivial way to defeat
    // per-attendee rate limiting.
    const attendee =
      (existingAttendeeId
        ? await this.attendees.findByIdForEvent(existingAttendeeId, policy.eventId)
        : null) ?? (await this.attendees.create(policy.eventId, null));

    const token = await this.tokens.issue({ sub: attendee.id, eventId: policy.eventId });

    return { session: toAttendeeSessionResponse(attendee, policy), token };
  }

  private async requireJoinableEvent(joinCode: string): Promise<EventSubmissionPolicy> {
    const policy = await this.policies.findByJoinCode(joinCode);

    // Unknown code, draft, closed, archived and PRIVATE all produce one
    // identical 404. Any distinction would let someone probe for valid codes or
    // learn an event exists before its organizer chose to reveal it.
    if (!policy || !isPubliclyVisible(policy.status, policy.accessMode)) {
      throw new EventNotFoundError();
    }

    return policy;
  }
}

/**
 * Submitting a question.
 *
 * The order of the checks below is deliberate, cheapest and most-conclusive
 * first, so a hostile request is refused before it costs a database round trip:
 *
 *   1. is the event taking questions at all
 *   2. is this attendee real and not blocked
 *   3. is this a retry of something already accepted
 *   4. does the event's identity policy allow this submission
 *   5. normalise, then apply the event's own length limits
 *   6. has this attendee exhausted their allowance
 *   7. have they already asked exactly this
 *   8. does it look like spam
 *   9. does it closely resemble an existing question
 *  10. persist, with a status the client had no say in
 */
@Injectable()
export class SubmitQuestionUseCase {
  constructor(
    @Inject(EVENT_POLICY_READER) private readonly policies: EventPolicyReader,
    @Inject(ATTENDEE_REPOSITORY) private readonly attendees: AttendeeRepository,
    @Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  async execute(input: {
    joinCode: string;
    attendee: AttendeeTokenClaims;
    request: SubmitQuestionRequest;
    idempotencyKey?: string | undefined;
  }): Promise<PublicQuestionResponse> {
    const policy = await resolvePolicyForAttendee(this.policies, input.joinCode, input.attendee);
    const eventId = policy.eventId;

    // 1. Only a published event takes questions. Saying so is safe here and
    //    only here: the caller already proved they hold a token minted for this
    //    event, so "it has closed" tells them nothing they could not observe.
    //    An attacker without a token never reaches this line — the guard
    //    refuses them, and the unauthenticated lookup answers a flat 404.
    if (policy.status !== 'PUBLISHED') {
      throw new EventNotAcceptingQuestionsError(policy.status);
    }

    // 2. Identity must resolve within THIS event.
    const attendee = await this.attendees.findByIdForEvent(input.attendee.sub, eventId);
    if (!attendee) throw new AttendeeSessionRequiredError();
    if (attendee.isBlocked) throw new AttendeeBlockedError();

    // 3. Retry safety, before anything is consumed. Venue wifi genuinely drops
    //    requests, and a resend must not cost the attendee a second question or
    //    a slice of their quota.
    if (input.idempotencyKey) {
      const already = await this.questions.findByIdempotencyKey(attendee.id, input.idempotencyKey);
      if (already) {
        return toPublicQuestionResponse({ ...already, isMine: true }, policy);
      }
    }

    // 4. Identity policy is applied server-side; the client's `isAnonymous` is
    //    a request, not an instruction.
    const identity = resolveIdentity(policy, input.request, attendee);

    // 5. Length is measured AFTER normalisation, so invisible padding can
    //    neither smuggle a body past a maximum nor fake its way past a minimum.
    const normalized = normalizeQuestion(input.request.body);
    if (normalized.length < policy.minQuestionLength) {
      throw new QuestionTooShortError(policy.minQuestionLength, normalized.length);
    }
    if (normalized.length > policy.maxQuestionLength) {
      throw new QuestionTooLongError(policy.maxQuestionLength, normalized.length);
    }

    // 6. Per-attendee allowance, from the event's own settings.
    await this.enforceSubmissionLimit(attendee.id, policy);

    // 7. Exact duplicate. The unique index settles a genuine race; this exists
    //    so the ordinary case gets a clean 409 without provoking one.
    const duplicate = await this.questions.findByBodyHash(attendee.id, normalized.bodyHash);
    if (duplicate) throw new DuplicateQuestionError();

    // 8. Zero-cost spam assessment. No model, no API call, no per-question cost.
    const assessment = assessForSpam(normalized.body, normalized.normalizedBody, {
      profanityFilter: policy.profanityFilter,
    });

    // 9. Near-duplicate detection routes to a moderator, never rejects: two
    //    people independently asking something similar is normal, and merging
    //    is a moderation decision rather than a reason to refuse someone.
    const similar = await this.questions.findSimilar(eventId, normalized.normalizedBody);

    const flags = [...assessment.signals];
    if (similar) flags.push('possible_duplicate');

    let status = statusOnSubmission(policy.moderationMode, assessment.verdict);
    if (similar && status === 'APPROVED') status = 'PENDING';

    // 10. Persist. Note what is NOT read from the request: status, eventId,
    //     attendeeId, upvoteCount. None of them exist in the write contract.
    const created = await this.questions.create({
      eventId,
      attendeeId: attendee.id,
      body: normalized.body,
      normalizedBody: normalized.normalizedBody,
      bodyHash: normalized.bodyHash,
      status,
      isAnonymous: identity.isAnonymous,
      idempotencyKey: input.idempotencyKey,
      flags,
      possibleDuplicateOfQuestionId: similar?.id,
    });

    await this.attendees.touch(attendee.id, identity.displayName ?? undefined);

    return toPublicQuestionResponse(
      { ...created, authorName: identity.displayName, isMine: true },
      policy,
    );
  }

  private async enforceSubmissionLimit(
    attendeeId: string,
    policy: EventSubmissionPolicy,
  ): Promise<void> {
    // The rule is built per event rather than being a constant: a 500-person
    // conference and a 12-person workshop want very different allowances, and
    // the organizer already configures this on the event.
    const decision = await this.rateLimiter.consume(
      {
        name: 'question:submit',
        limit: policy.submitLimitCount,
        windowSeconds: policy.submitLimitWindowSeconds,
      },
      attendeeId,
    );

    if (!decision.allowed) {
      throw new SubmissionLimitReachedError(decision.retryAfterSeconds, policy.submitLimitCount);
    }
  }
}

/** The attendee's board: what the room can see, plus their own pending questions. */
@Injectable()
export class ListPublicQuestionsUseCase {
  constructor(
    @Inject(EVENT_POLICY_READER) private readonly policies: EventPolicyReader,
    @Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
  ) {}

  async execute(input: {
    joinCode: string;
    attendee: AttendeeTokenClaims;
    query: CursorPaginationQuery;
  }): Promise<PublicQuestionListResponse> {
    const policy = await resolvePolicyForAttendee(this.policies, input.joinCode, input.attendee);

    const page = await this.questions.findVisibleForAttendee({
      eventId: policy.eventId,
      attendeeId: input.attendee.sub,
      cursor: input.query.cursor,
      limit: input.query.limit,
    });

    return {
      items: page.items.map((item) => toPublicQuestionResponse(item, policy)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}

/** The moderation queue. Org-scoped at the repository, not filtered afterwards. */
@Injectable()
export class ListModerationQueueUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository) {}

  async execute(
    eventId: string,
    query: ModerationQueueQuery,
    context: RequestContext,
  ): Promise<ModerationQueueResponse> {
    /**
     * The search term is folded exactly as stored text was folded, here in the
     * application layer where the rule already lives — so searching "cafe"
     * finds "Café", and the repository never has to know how question text is
     * normalised. Two implementations of that would drift, and the symptom
     * would be a search that quietly stops matching.
     */
    const search = query.search ? normalizeForComparison(query.search) : undefined;

    /**
     * A term made entirely of punctuation normalises to nothing.
     *
     * Passing it through would become `contains: ''`, which matches every
     * question — so a moderator searching "???" would be shown the whole event
     * and reasonably conclude the search box is broken. An empty result is the
     * honest answer.
     */
    if (search !== undefined && search.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const page = await this.questions.findForModeration({
      eventId,
      orgId: context.orgId,
      status: query.status,
      search,
      sort: query.sort,
      cursor: query.cursor,
      limit: query.limit,
    });

    return {
      items: page.items.map(toQuestionResponse),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}

/**
 * Question counts for one event.
 *
 * Small enough to be polled every few seconds, which is what it is for: the
 * dashboard watches `version` here and re-runs the far more expensive list
 * query only when it moves. That is the whole of EventQ's "realtime" story for
 * this surface, and it is a deliberate choice rather than a missing feature —
 * see the endpoint documentation for the argument against SSE here.
 */
@Injectable()
export class GetQuestionStatsUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository) {}

  async execute(eventId: string, context: RequestContext): Promise<QuestionStatsResponse> {
    // Org-scoped like every other organizer read. An event owned by another
    // organization reports all zeros — identical to one that exists and has no
    // questions, so the endpoint cannot be used to probe for real event ids.
    return toQuestionStatsResponse(
      await this.questions.countByStatusForOrg(eventId, context.orgId),
    );
  }
}

/**
 * Applying a moderation decision.
 *
 * The client sends an ACTION. This resolves it to a destination state and then
 * checks that state is reachable from where the question actually is — so a
 * stale dashboard cannot approve something another moderator already archived,
 * and a crafted request cannot name a state at all.
 */
@Injectable()
export class ModerateQuestionUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository) {}

  async execute(
    questionId: string,
    request: ModerateQuestionRequest,
    context: RequestContext,
  ): Promise<QuestionResponse> {
    const question = await this.questions.findByIdForOrg(questionId, context.orgId);

    // Identical outcome whether the question does not exist or belongs to
    // another organization. Distinguishing them would confirm which ids are real.
    if (!question) throw new QuestionNotFoundError();

    const target = targetStatusFor(request.action);
    if (!canTransition(question.status, target)) {
      throw new InvalidQuestionTransitionError(question.status, target);
    }

    return toQuestionResponse(
      await this.questions.applyModeration({
        questionId,
        orgId: context.orgId,
        status: target,
        // From the session, so an action can never be attributed to someone else.
        actorId: context.userId,
        action: request.action,
        reason: request.reason,
      }),
    );
  }
}

/**
 * Resolves the event an attendee is acting on, and proves they may.
 *
 * This is where the token's `eventId` claim is checked against the join code in
 * the URL. Without it, a token minted for a quiet workshop could be presented on
 * a keynote's endpoint — the signature would verify perfectly, because it is a
 * genuine token; it is simply a token for somewhere else.
 *
 * The order of the failures matters as much as the failures themselves:
 *
 *   unknown code   -> 404, identical to the unauthenticated lookup
 *   PRIVATE event  -> 404, so a valid code cannot be confirmed by probing
 *   wrong event    -> 401, revealing nothing about whether the event exists
 *
 * Only after all three does any caller learn anything specific about the event,
 * and by then they have proved they legitimately joined it.
 */
async function resolvePolicyForAttendee(
  policies: EventPolicyReader,
  joinCode: string,
  attendee: AttendeeTokenClaims,
): Promise<EventSubmissionPolicy> {
  const policy = await policies.findByJoinCode(joinCode);

  if (!policy || policy.accessMode === 'PRIVATE') throw new EventNotFoundError();
  if (policy.eventId !== attendee.eventId) throw new AttendeeSessionRequiredError();

  return policy;
}

/**
 * Resolves who a question is attributed to.
 *
 * The event's policy wins over the client's preference in both directions, and
 * that asymmetry is the point: an ANONYMOUS event never attributes a question
 * even if a name was sent, and a REQUIRED event refuses one without a name even
 * if the client asked to hide it.
 */
function resolveIdentity(
  policy: EventSubmissionPolicy,
  request: SubmitQuestionRequest,
  attendee: AttendeeRecord,
): { displayName: string | null; isAnonymous: boolean } {
  if (policy.attendeeIdentityMode === 'ANONYMOUS') {
    // Nothing is stored and nothing is shown, whatever was sent.
    return { displayName: null, isAnonymous: true };
  }

  const provided = request.displayName ? normalizeDisplayName(request.displayName) : null;
  // Fall back to the name already on the identity, so someone who gave it once
  // is not asked again on every question.
  const name = provided && provided.length > 0 ? provided : attendee.displayName;

  if (policy.attendeeIdentityMode === 'REQUIRED') {
    if (!name) throw new IdentityRequiredError();
    // Hiding is not on offer at an event that requires identity.
    return { displayName: name, isAnonymous: false };
  }

  // OPTIONAL. Anonymity is honoured only if the organizer permits it, and a
  // question with no name available is anonymous whether or not it asked to be.
  const wantsAnonymous = request.isAnonymous && policy.allowAnonymousPost;
  if (wantsAnonymous || !name) {
    return { displayName: null, isAnonymous: true };
  }

  return { displayName: name, isAnonymous: false };
}
