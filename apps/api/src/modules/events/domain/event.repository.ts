import type {
  AttendeeIdentityMode,
  EventAccessMode,
  EventStatus,
  EventType,
  ModerationMode,
} from '@eventq/contracts';

/**
 * Port: event persistence.
 *
 * Note the shape of every read method: `orgId` is a REQUIRED parameter, never
 * an optional filter. An org-scoped lookup is therefore the only kind that can
 * be written — the compiler will not let a caller forget it, which is what
 * turns "remember to check ownership" into something structural.
 */

export interface EventSettingsData {
  accessMode: EventAccessMode;
  moderationMode: ModerationMode;
  attendeeIdentityMode: AttendeeIdentityMode;
}

/**
 * A partial settings change.
 *
 * Written out with explicit `| undefined` rather than as `Partial<...>`:
 * under exactOptionalPropertyTypes those are different types, and only this
 * form accepts an object that carries the key with an undefined value — which
 * is exactly what a parsed optional field looks like.
 */
export interface EventSettingsPatch {
  accessMode?: EventAccessMode | undefined;
  moderationMode?: ModerationMode | undefined;
  attendeeIdentityMode?: AttendeeIdentityMode | undefined;
}

export interface EventRecord {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  venue: string | null;
  type: EventType;
  status: EventStatus;
  joinCode: string;
  slug: string;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  isPubliclyListed: boolean;
  publishedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  settings: EventSettingsData;
}

/** An event plus the organization that owns it, for the public view. */
export interface PublicEventRecord extends EventRecord {
  organizationName: string;
}

export interface CreateEventData {
  orgId: string;
  createdById: string;
  title: string;
  description?: string | undefined;
  venue?: string | undefined;
  type?: EventType | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
  timezone?: string | undefined;
  settings?: EventSettingsPatch | undefined;
  isPubliclyListed?: boolean | undefined;
}

/**
 * Update payload.
 *
 * `null` clears a field, `undefined` leaves it untouched. Conflating the two
 * would make a PATCH that omits `venue` silently erase it.
 */
export interface UpdateEventData {
  title?: string | undefined;
  description?: string | null | undefined;
  venue?: string | null | undefined;
  type?: EventType | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
  timezone?: string | undefined;
  settings?: EventSettingsPatch | undefined;
  isPubliclyListed?: boolean | undefined;
}

export interface EventPage {
  items: EventRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface EventRepository {
  /** Scoped to one organization. Returns null for an event that does not exist
   *  AND for one owned by another organization — callers cannot tell the
   *  difference, and must not be able to. */
  findByIdForOrg(eventId: string, orgId: string): Promise<EventRecord | null>;

  findManyForOrg(input: {
    orgId: string;
    status?: EventStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<EventPage>;

  /** Unauthenticated lookup by public identifier. Visibility rules are applied
   *  by the caller, not here. */
  findByJoinCode(joinCode: string): Promise<PublicEventRecord | null>;

  create(data: CreateEventData): Promise<EventRecord>;

  update(eventId: string, orgId: string, data: UpdateEventData): Promise<EventRecord>;

  setStatus(
    eventId: string,
    orgId: string,
    status: EventStatus,
    timestamps?: { publishedAt?: Date | null; closedAt?: Date | null },
  ): Promise<EventRecord>;

  /** Permanent removal. Only ever called for an untouched draft. */
  hardDelete(eventId: string, orgId: string): Promise<void>;

  /** How many attendees have engaged. Drives the safe-deletion decision. */
  countParticipants(eventId: string): Promise<number>;

  joinCodeExists(joinCode: string): Promise<boolean>;

  slugExistsInOrg(orgId: string, slug: string): Promise<boolean>;
}

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');
