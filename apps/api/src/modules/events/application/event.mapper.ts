import type { EventResponse, PublicEventResponse } from '@eventq/contracts';
import type { EventRecord, PublicEventRecord } from '../domain/event.repository';

/**
 * Record -> contract.
 *
 * Every response is built field by field rather than by spreading the record.
 * A spread would leak whatever the persistence layer happens to add next, which
 * is how internal columns end up on the public wire without anyone deciding to
 * put them there.
 */
export function toEventResponse(record: EventRecord): EventResponse {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    venue: record.venue,
    type: record.type,
    status: record.status,
    joinCode: record.joinCode,
    slug: record.slug,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    timezone: record.timezone,
    settings: {
      accessMode: record.settings.accessMode,
      moderationMode: record.settings.moderationMode,
      attendeeIdentityMode: record.settings.attendeeIdentityMode,
      isPubliclyListed: record.isPubliclyListed,
    },
    organizationId: record.orgId,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    closedAt: record.closedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * The attendee view.
 *
 * A separate, narrower shape rather than a filtered EventResponse: internal
 * ids, settings and lifecycle timestamps have no representation here at all, so
 * they cannot be exposed by forgetting to strip them.
 */
export function toPublicEventResponse(record: PublicEventRecord): PublicEventResponse {
  return {
    title: record.title,
    description: record.description,
    venue: record.venue,
    type: record.type,
    joinCode: record.joinCode,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    timezone: record.timezone,
    organizationName: record.organizationName,
  };
}
