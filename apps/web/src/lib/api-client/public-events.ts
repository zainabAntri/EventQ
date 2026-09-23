import {
  AttendeeSessionResponse,
  PublicEventResponse,
  PublicQuestionListResponse,
  PublicQuestionResponse,
  VoteResponse,
  type SubmitQuestionRequest,
} from '@eventq/contracts';
import { apiRequest } from './index';

/**
 * The attendee surface, typed from the shared contract.
 *
 * Every response is validated against the same schema the API validates it
 * with, so a backend change that breaks this page fails loudly here rather than
 * surfacing as an undefined three components deep during someone's event.
 */

/** Unauthenticated event lookup. Called from a Server Component. */
export function getPublicEvent(joinCode: string): Promise<PublicEventResponse> {
  return apiRequest(`/public/events/${encodeURIComponent(joinCode)}`, {
    schema: PublicEventResponse,
  });
}

/**
 * Joins the event, minting a pseudonymous identity.
 *
 * The token comes back as an httpOnly cookie, not in this response — so there
 * is nothing here for the page to store, and nothing an injected script could
 * read. Calling it again simply returns the identity the device already holds.
 */
export function joinEvent(joinCode: string): Promise<AttendeeSessionResponse> {
  return apiRequest(`/public/events/${encodeURIComponent(joinCode)}/attendee`, {
    method: 'POST',
    schema: AttendeeSessionResponse,
  });
}

/**
 * Submits a question.
 *
 * `idempotencyKey` is required rather than optional, deliberately. Venue wifi
 * drops requests constantly, and the retry path is the normal path here — an
 * optional parameter would eventually be forgotten at exactly the call site
 * where a double-post matters.
 */
export function submitQuestion(
  joinCode: string,
  body: SubmitQuestionRequest,
  idempotencyKey: string,
): Promise<PublicQuestionResponse> {
  return apiRequest(`/public/events/${encodeURIComponent(joinCode)}/questions`, {
    method: 'POST',
    body,
    idempotencyKey,
    schema: PublicQuestionResponse,
  });
}

/**
 * The board: what the room can see, plus the caller's own pending questions.
 *
 * Every item carries hasVoted for THIS attendee, so a reloaded page renders
 * the right button state without a second request per question.
 */
export function listPublicQuestions(
  joinCode: string,
  options: { cursor?: string; signal?: AbortSignal } = {},
): Promise<PublicQuestionListResponse> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  const search = params.toString();

  return apiRequest(
    `/public/events/${encodeURIComponent(joinCode)}/questions${search ? `?${search}` : ''}`,
    {
      schema: PublicQuestionListResponse,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/**
 * The public record of a finished event.
 *
 * No attendee token, deliberately: a closed event mints none, so this is the
 * only attendee-facing read that carries no identity at all. Every item comes
 * back with `isMine` and `hasVoted` false, because there is no "me" here.
 */
export function listEventArchive(
  joinCode: string,
  options: { cursor?: string; signal?: AbortSignal } = {},
): Promise<PublicQuestionListResponse> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  const search = params.toString();

  return apiRequest(
    `/public/events/${encodeURIComponent(joinCode)}/archive${search ? `?${search}` : ''}`,
    {
      schema: PublicQuestionListResponse,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/**
 * Upvote and withdraw.
 *
 * PUT and DELETE rather than POST because both are idempotent: "make sure my
 * vote exists" and "make sure it does not". A double-tap, a retry on dropped
 * wifi and a page refresh therefore all produce the same state as one honest
 * tap, and none of them produce an error. There is no body — the identity is
 * the attendee cookie and the question is in the URL.
 */
export function castVote(joinCode: string, questionId: string): Promise<VoteResponse> {
  return apiRequest(
    `/public/events/${encodeURIComponent(joinCode)}/questions/${encodeURIComponent(questionId)}/vote`,
    { method: 'PUT', schema: VoteResponse },
  );
}

export function withdrawVote(joinCode: string, questionId: string): Promise<VoteResponse> {
  return apiRequest(
    `/public/events/${encodeURIComponent(joinCode)}/questions/${encodeURIComponent(questionId)}/vote`,
    { method: 'DELETE', schema: VoteResponse },
  );
}
