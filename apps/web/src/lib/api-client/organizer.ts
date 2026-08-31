import { z } from 'zod';
import {
  AuthSessionResponse,
  EventListResponse,
  EventResponse,
  ModerationQueueResponse,
  QuestionResponse,
  QuestionStatsResponse,
  type LoginRequest,
  type ModerationQueueQuery,
  type QuestionModerationAction,
} from '@eventq/contracts';
import { apiRequest } from './index';

/**
 * The organizer surface, typed from the shared contract.
 *
 * Every response is validated against the same schema the API validates it
 * with, so a backend change that breaks the dashboard fails loudly here rather
 * than surfacing as an undefined three components deep during someone's event.
 *
 * All of these are called from CLIENT components, unlike the attendee page
 * which renders on the server. The reason is the session cookie: it is set by
 * the API on its own origin, and `credentials: 'include'` in the shared request
 * helper is what sends it back. A Server Component has no ambient cookie jar
 * and would have to forward the header by hand on every call — more moving
 * parts, and none of these screens need server rendering. The dashboard is
 * behind a login and has nothing to say to a search engine.
 */

/** Signing out returns 204, so there is no body to validate. */
const NoContent = z.void();

export function signIn(body: LoginRequest): Promise<AuthSessionResponse> {
  return apiRequest('/auth/login', { method: 'POST', body, schema: AuthSessionResponse });
}

export function signOut(): Promise<void> {
  return apiRequest('/auth/logout', { method: 'POST', schema: NoContent });
}

/**
 * The signed-in organizer.
 *
 * Also the session check every dashboard screen makes on mount: a 401 from here
 * is how the UI learns to send someone to the sign-in page.
 */
export function getCurrentOrganizer(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return apiRequest('/auth/me', { schema: AuthSessionResponse, ...(signal ? { signal } : {}) });
}

export function listEvents(signal?: AbortSignal): Promise<EventListResponse> {
  return apiRequest('/events', { schema: EventListResponse, ...(signal ? { signal } : {}) });
}

export function getEvent(eventId: string, signal?: AbortSignal): Promise<EventResponse> {
  return apiRequest(`/events/${encodeURIComponent(eventId)}`, {
    schema: EventResponse,
    ...(signal ? { signal } : {}),
  });
}

/**
 * A page of the moderation queue.
 *
 * `cursor` is opaque and must be passed back exactly as received — it encodes
 * the sort it was minted for, and the API refuses it under any other, which is
 * what stops a stale cursor from returning a page from nowhere in particular.
 */
export function listQuestions(
  eventId: string,
  query: Partial<ModerationQueueQuery>,
  signal?: AbortSignal,
): Promise<ModerationQueueResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.search) params.set('search', query.search);
  if (query.sort) params.set('sort', query.sort);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));

  const search = params.toString();

  return apiRequest(
    `/events/${encodeURIComponent(eventId)}/questions${search ? `?${search}` : ''}`,
    {
      schema: ModerationQueueResponse,
      ...(signal ? { signal } : {}),
    },
  );
}

/**
 * Counts by status, plus a change token.
 *
 * Cheap enough to poll every few seconds, which is exactly how the dashboard
 * stays current: it watches `version` here and refetches the list only when
 * that moves. See the endpoint's own documentation for why this replaces a
 * realtime transport on the organizer surface.
 */
export function getQuestionStats(
  eventId: string,
  signal?: AbortSignal,
): Promise<QuestionStatsResponse> {
  return apiRequest(`/events/${encodeURIComponent(eventId)}/questions/stats`, {
    schema: QuestionStatsResponse,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Applies a moderation decision.
 *
 * Sends an ACTION, never a target status — the server decides what state that
 * action leads to and whether it is legal from where the question actually is.
 * The dashboard only ever offers actions the API returned in `allowedActions`,
 * so it cannot ask for something that will be refused.
 */
export function moderateQuestion(
  questionId: string,
  action: QuestionModerationAction,
  reason?: string,
): Promise<QuestionResponse> {
  return apiRequest(`/questions/${encodeURIComponent(questionId)}/moderate`, {
    method: 'POST',
    body: { action, ...(reason ? { reason } : {}) },
    schema: QuestionResponse,
  });
}
