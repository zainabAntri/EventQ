import type {
  AttendeeIdentityMode,
  EventAccessMode,
  EventStatus,
  ModerationMode,
} from '@eventq/contracts';

/**
 * Port: the submission policy of one event.
 *
 * Declared HERE rather than imported from the events module, even though the
 * data lives in the same database. EventQ is a modular monolith: feature
 * modules talk through explicit interfaces, not through each other's internals.
 * Reaching into EventRepository would couple question submission to every
 * future change in how events are stored.
 *
 * It is also a genuinely different shape. The events module cares about titles,
 * slugs and lifecycle timestamps; question submission cares about none of those
 * and needs the length and rate limits the events module never reads. A narrow
 * port asks for exactly what it uses.
 */
export interface EventSubmissionPolicy {
  eventId: string;
  status: EventStatus;
  accessMode: EventAccessMode;

  moderationMode: ModerationMode;
  attendeeIdentityMode: AttendeeIdentityMode;
  allowAnonymousPost: boolean;

  minQuestionLength: number;
  maxQuestionLength: number;

  /** Sliding-window submission limit, per attendee. */
  submitLimitCount: number;
  submitLimitWindowSeconds: number;

  profanityFilter: boolean;
}

export interface EventPolicyReader {
  /**
   * Lookup by public identifier. Visibility rules are applied by the caller,
   * not here — the same split the events module uses.
   *
   * Deliberately the ONLY method. An earlier draft also had findById, but every
   * attendee route reaches an event through the join code in its URL, and the
   * token's eventId must then be checked against it. A by-id lookup would let a
   * caller resolve an event without that check ever happening — the exact hole
   * that makes a token for one event usable on another.
   */
  findByJoinCode(joinCode: string): Promise<EventSubmissionPolicy | null>;
}

export const EVENT_POLICY_READER = Symbol('EVENT_POLICY_READER');
