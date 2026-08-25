import {
  AttendeeSessionResponse,
  PublicEventResponse,
  PublicQuestionResponse,
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
