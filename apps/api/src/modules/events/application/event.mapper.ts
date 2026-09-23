import type { EventResponse, PublicEventResponse, PublicEventStatus } from '@eventq/contracts';
import type { EventRecord, PublicEventRecord } from '../domain/event.repository';
import { joinUrlFor } from '../domain/join-code';

/**
 * Record -> contract.
 *
 * Every response is built field by field rather than by spreading the record.
 * A spread would leak whatever the persistence layer happens to add next, which
 * is how internal columns end up on the public wire without anyone deciding to
 * put them there.
 */
export function toEventResponse(record: EventRecord, webOrigin: string): EventResponse {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    venue: record.venue,
    type: record.type,
    status: record.status,
    joinCode: record.joinCode,
    // Built here rather than by each client, so the poster, the dashboard and
    // the projector cannot disagree about where attendees go.
    joinUrl: joinUrlFor(webOrigin, record.joinCode),
    slug: record.slug,
    accentColor: record.accentColor,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    timezone: record.timezone,
    settings: {
      accessMode: record.settings.accessMode,
      moderationMode: record.settings.moderationMode,
      attendeeIdentityMode: record.settings.attendeeIdentityMode,
      isPubliclyListed: record.isPubliclyListed,
      allowUpvotes: record.settings.allowUpvotes,
      aiEnabled: record.settings.aiEnabled,
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
export function toPublicEventResponse(
  record: PublicEventRecord,
  /**
   * Passed in rather than derived from `record.status`.
   *
   * The caller has already decided what this visitor may see, and that decision
   * is the security control. Recomputing it here would put a second copy of the
   * rule in the mapper, where a later edit could widen what is disclosed
   * without touching the use case that is supposed to own it. The narrow type
   * also makes it impossible to hand back DRAFT or ARCHIVED by accident.
   */
  visibility: 'open' | 'closed',
): PublicEventResponse {
  const status: PublicEventStatus = visibility === 'closed' ? 'CLOSED' : 'PUBLISHED';

  return {
    title: record.title,
    description: record.description,
    venue: record.venue,
    type: record.type,
    joinCode: record.joinCode,
    status,
    // Only ever populated for a closed event: there is nothing to say about
    // when a live event ended, and a stray timestamp on an open one would be
    // rendered as "this finished" by a client that trusted the field.
    closedAt: status === 'CLOSED' ? (record.closedAt?.toISOString() ?? null) : null,
    accentColor: record.accentColor,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    timezone: record.timezone,
    organizationName: record.organizationName,
  };
}
