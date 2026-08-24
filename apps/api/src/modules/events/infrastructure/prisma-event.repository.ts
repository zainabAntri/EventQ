import { Injectable } from '@nestjs/common';
import type { EventStatus } from '@eventq/contracts';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  CreateEventData,
  EventPage,
  EventRecord,
  EventRepository,
  PublicEventRecord,
  UpdateEventData,
} from '../domain/event.repository';

/**
 * Prisma adapter for EventRepository.
 *
 * EVERY query that reads or writes an event includes `orgId` in its WHERE
 * clause. This is the data-layer half of the authorization story: even if a
 * guard were bypassed or a use-case forgot to check, a cross-organization row
 * simply does not match.
 */
@Injectable()
export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdForOrg(eventId: string, orgId: string): Promise<EventRecord | null> {
    const event = await this.prisma.event.findFirst({
      // orgId is part of the predicate, not applied afterwards in JavaScript.
      where: { id: eventId, orgId, deletedAt: null },
      include: { settings: true },
    });

    return event ? toRecord(event) : null;
  }

  async findManyForOrg(input: {
    orgId: string;
    status?: EventStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<EventPage> {
    // One extra row tells us whether another page exists without a second
    // COUNT query over a table that only grows.
    const rows = await this.prisma.event.findMany({
      where: {
        orgId: input.orgId,
        deletedAt: null,
        // Archived events are soft-deleted and must not appear in any listing,
        // even when no status filter was requested.
        status: input.status ?? { not: 'ARCHIVED' },
      },
      include: { settings: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;

    return {
      items: items.map(toRecord),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async findByJoinCode(joinCode: string): Promise<PublicEventRecord | null> {
    const event = await this.prisma.event.findFirst({
      where: { joinCode, deletedAt: null },
      include: { settings: true, org: { select: { name: true } } },
    });

    return event ? { ...toRecord(event), organizationName: event.org.name } : null;
  }

  async create(data: CreateEventData & { joinCode?: string; slug?: string }): Promise<EventRecord> {
    const created = await this.prisma.event.create({
      data: {
        orgId: data.orgId,
        createdById: data.createdById,
        title: data.title,
        description: data.description ?? null,
        venue: data.venue ?? null,
        ...(data.type ? { type: data.type } : {}),
        joinCode: data.joinCode as string,
        slug: data.slug as string,
        startsAt: data.startsAt ?? null,
        endsAt: data.endsAt ?? null,
        ...(data.timezone ? { timezone: data.timezone } : {}),
        ...(data.isPubliclyListed !== undefined ? { isPubliclyListed: data.isPubliclyListed } : {}),
        // Settings are created alongside the event, so an event always has
        // them and no read has to cope with a missing row.
        settings: { create: settingsCreate(data.settings) },
      },
      include: { settings: true },
    });

    return toRecord(created);
  }

  async update(eventId: string, orgId: string, data: UpdateEventData): Promise<EventRecord> {
    const updated = await this.prisma.event.update({
      // updateMany-style predicate via a compound where is not available on
      // update(); ownership was already established by findByIdForOrg, and the
      // org guard below keeps the write scoped too.
      where: { id: eventId, orgId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.venue !== undefined ? { venue: data.venue } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
        ...(data.endsAt !== undefined ? { endsAt: data.endsAt } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.isPubliclyListed !== undefined ? { isPubliclyListed: data.isPubliclyListed } : {}),
        ...(data.settings ? { settings: { update: settingsUpdate(data.settings) } } : {}),
      },
      include: { settings: true },
    });

    return toRecord(updated);
  }

  async setStatus(
    eventId: string,
    orgId: string,
    status: EventStatus,
    timestamps?: { publishedAt?: Date | null; closedAt?: Date | null },
  ): Promise<EventRecord> {
    const updated = await this.prisma.event.update({
      where: { id: eventId, orgId },
      data: {
        status,
        ...(timestamps?.publishedAt !== undefined ? { publishedAt: timestamps.publishedAt } : {}),
        ...(timestamps?.closedAt !== undefined ? { closedAt: timestamps.closedAt } : {}),
        // Archiving is a soft delete: deletedAt is what removes it from every
        // scoped read, including the public lookup.
        ...(status === 'ARCHIVED' ? { deletedAt: new Date() } : {}),
      },
      include: { settings: true },
    });

    return toRecord(updated);
  }

  async hardDelete(eventId: string, orgId: string): Promise<void> {
    // deleteMany, not delete: the orgId predicate is enforced by the database,
    // and a non-matching id deletes nothing rather than throwing.
    await this.prisma.event.deleteMany({ where: { id: eventId, orgId } });
  }

  countParticipants(eventId: string): Promise<number> {
    return this.prisma.attendee.count({ where: { eventId } });
  }

  async joinCodeExists(joinCode: string): Promise<boolean> {
    const found = await this.prisma.event.findUnique({
      where: { joinCode },
      select: { id: true },
    });
    return found !== null;
  }

  async slugExistsInOrg(orgId: string, slug: string): Promise<boolean> {
    const found = await this.prisma.event.findFirst({
      where: { orgId, slug },
      select: { id: true },
    });
    return found !== null;
  }
}

function settingsCreate(settings: CreateEventData['settings']) {
  return {
    ...(settings?.accessMode ? { accessMode: settings.accessMode } : {}),
    ...(settings?.moderationMode ? { moderationMode: settings.moderationMode } : {}),
    ...(settings?.attendeeIdentityMode
      ? { attendeeIdentityMode: settings.attendeeIdentityMode }
      : {}),
  };
}

function settingsUpdate(settings: NonNullable<UpdateEventData['settings']>) {
  return {
    ...(settings.accessMode ? { accessMode: settings.accessMode } : {}),
    ...(settings.moderationMode ? { moderationMode: settings.moderationMode } : {}),
    ...(settings.attendeeIdentityMode
      ? { attendeeIdentityMode: settings.attendeeIdentityMode }
      : {}),
  };
}

interface EventRow {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  venue: string | null;
  type: string;
  status: string;
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
  settings: {
    accessMode: string;
    moderationMode: string;
    attendeeIdentityMode: string;
  } | null;
}

/** Maps a row to the domain shape so no ORM type escapes this file. */
function toRecord(event: EventRow): EventRecord {
  return {
    id: event.id,
    orgId: event.orgId,
    title: event.title,
    description: event.description,
    venue: event.venue,
    type: event.type as EventRecord['type'],
    status: event.status as EventStatus,
    joinCode: event.joinCode,
    slug: event.slug,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    isPubliclyListed: event.isPubliclyListed,
    publishedAt: event.publishedAt,
    closedAt: event.closedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    settings: {
      // Defaults mirror the schema, so a legacy row without a settings record
      // reads as the safe configuration rather than crashing.
      accessMode: (event.settings?.accessMode ?? 'PUBLIC') as EventRecord['settings']['accessMode'],
      moderationMode: (event.settings?.moderationMode ??
        'PRE') as EventRecord['settings']['moderationMode'],
      attendeeIdentityMode: (event.settings?.attendeeIdentityMode ??
        'OPTIONAL') as EventRecord['settings']['attendeeIdentityMode'],
    },
  };
}
