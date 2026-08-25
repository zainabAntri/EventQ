import { z } from 'zod';
import { EntityId, JoinCode } from './primitives.js';
import {
  AttendeeIdentityMode,
  EventAccessMode,
  EventStatus,
  EventType,
  ModerationMode,
} from './enums.js';

/**
 * Event contracts.
 *
 * The write shapes below are the primary defence against mass assignment: they
 * contain ONLY what a client is allowed to set. `status`, `joinCode`, `orgId`,
 * `id` and every timestamp are absent by construction, so no request can move
 * an event between organizations or publish it by sending an extra field.
 * Status changes have their own explicit endpoints.
 */

export const EventTitle = z.string().trim().min(3).max(300);
export const EventDescription = z.string().trim().max(5_000);

/**
 * IANA zone, validated against the runtime's own tz database rather than a
 * hard-coded list that would go stale.
 */
export const Timezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { error: 'Unknown timezone. Use an IANA name such as "Europe/London".' },
);

/** Settings an organizer may change. */
export const EventSettingsInput = z.object({
  accessMode: EventAccessMode.optional(),
  moderationMode: ModerationMode.optional(),
  attendeeIdentityMode: AttendeeIdentityMode.optional(),
  /** Opt-in search-engine indexing. Off by default: an indexed event page
   *  exposes its contents publicly, which is a privacy decision, not an SEO
   *  one. */
  isPubliclyListed: z.boolean().optional(),
});
export type EventSettingsInput = z.infer<typeof EventSettingsInput>;

const eventWritableFields = {
  title: EventTitle,
  description: EventDescription.optional(),
  /** Free text: a room name, a full address or a video-call link all occur in
   *  practice, and forcing structure on them helps nobody. */
  venue: z.string().trim().max(500).optional(),
  type: EventType.optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  timezone: Timezone.optional(),
  settings: EventSettingsInput.optional(),
};

/** An end date before the start date is always a mistake worth catching. */
const chronological = <T extends { startsAt?: string | undefined; endsAt?: string | undefined }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'The event must end after it starts.',
    });
  }
};

export const CreateEventRequest = z.object(eventWritableFields).superRefine(chronological);
export type CreateEventRequest = z.infer<typeof CreateEventRequest>;

/**
 * Update.
 *
 * Every field optional, so a client may PATCH one attribute without resending
 * the whole event and accidentally clearing something it never displayed.
 */
export const UpdateEventRequest = z
  .object({
    title: EventTitle.optional(),
    description: EventDescription.nullable().optional(),
    venue: z.string().trim().max(500).nullable().optional(),
    type: EventType.optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    timezone: Timezone.optional(),
    settings: EventSettingsInput.optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one field to update.' });
    }
    chronological(
      {
        startsAt: value.startsAt ?? undefined,
        endsAt: value.endsAt ?? undefined,
      },
      ctx,
    );
  });
export type UpdateEventRequest = z.infer<typeof UpdateEventRequest>;

export const EventSettingsResponse = z.object({
  accessMode: EventAccessMode,
  moderationMode: ModerationMode,
  attendeeIdentityMode: AttendeeIdentityMode,
  isPubliclyListed: z.boolean(),
});
export type EventSettingsResponse = z.infer<typeof EventSettingsResponse>;

/** The organizer's view. */
export const EventResponse = z.object({
  id: EntityId,
  title: z.string(),
  description: z.string().nullable(),
  venue: z.string().nullable(),
  type: EventType,
  status: EventStatus,
  /** Public identifier, shown on screen and read aloud in the room. */
  joinCode: JoinCode,
  /**
   * The address the QR code points at. Derived server-side from the configured
   * web origin rather than assembled by each client, so the printed poster, the
   * dashboard and the projector cannot disagree about where attendees go.
   */
  joinUrl: z.url(),
  slug: z.string(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  timezone: z.string(),
  settings: EventSettingsResponse,
  organizationId: EntityId,
  publishedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EventResponse = z.infer<typeof EventResponse>;

/**
 * The attendee's view, reachable without authentication.
 *
 * A deliberately narrower shape rather than a filtered EventResponse: internal
 * ids, timestamps and settings simply do not exist here, so they cannot leak
 * through a forgotten field.
 */
export const PublicEventResponse = z.object({
  title: z.string(),
  description: z.string().nullable(),
  venue: z.string().nullable(),
  type: EventType,
  joinCode: JoinCode,
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  timezone: z.string(),
  organizationName: z.string(),
});
export type PublicEventResponse = z.infer<typeof PublicEventResponse>;

export const EventListQuery = z.object({
  status: EventStatus.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type EventListQuery = z.infer<typeof EventListQuery>;

export const EventListResponse = z.object({
  items: z.array(EventResponse),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type EventListResponse = z.infer<typeof EventListResponse>;

export const DeleteEventResponse = z.object({
  /** `deleted` = row removed. `archived` = soft-deleted because history had to
   *  be preserved. Clients show different wording for each. */
  outcome: z.enum(['deleted', 'archived']),
});
export type DeleteEventResponse = z.infer<typeof DeleteEventResponse>;
