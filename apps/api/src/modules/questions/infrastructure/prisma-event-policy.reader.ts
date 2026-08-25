import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { EventPolicyReader, EventSubmissionPolicy } from '../domain/event-policy.port';

/**
 * Prisma adapter for EventPolicyReader.
 *
 * Reads the event and its settings row directly rather than going through the
 * events module's repository. That is the modular-monolith boundary working as
 * intended: the two modules share a database, not an implementation, so a
 * change to how events are queried cannot ripple into question submission.
 *
 * `select` is explicit and narrow. The submission path runs on every question
 * at an event, so pulling the description, the logo key and the branding
 * columns on each one would be waste — and a `select` that names its columns
 * cannot silently start returning something new when the schema grows.
 */
@Injectable()
export class PrismaEventPolicyReader implements EventPolicyReader {
  constructor(private readonly prisma: PrismaService) {}

  async findByJoinCode(joinCode: string): Promise<EventSubmissionPolicy | null> {
    const event = await this.prisma.event.findFirst({
      where: { joinCode, deletedAt: null },
      select: SELECTION,
    });

    return event ? toPolicy(event) : null;
  }
}

const SELECTION = {
  id: true,
  status: true,
  settings: {
    select: {
      accessMode: true,
      moderationMode: true,
      attendeeIdentityMode: true,
      allowAnonymousPost: true,
      minQuestionLength: true,
      maxQuestionLength: true,
      submitLimitCount: true,
      submitLimitWindowSeconds: true,
      profanityFilter: true,
    },
  },
} as const;

interface EventPolicyRow {
  id: string;
  status: string;
  settings: {
    accessMode: string;
    moderationMode: string;
    attendeeIdentityMode: string;
    allowAnonymousPost: boolean;
    minQuestionLength: number;
    maxQuestionLength: number;
    submitLimitCount: number;
    submitLimitWindowSeconds: number;
    profanityFilter: boolean;
  } | null;
}

/**
 * Maps a row to the domain shape, so no ORM type escapes this file.
 *
 * The fallbacks mirror the schema defaults. An event whose settings row is
 * somehow missing then reads as the SAFE configuration — pre-moderated, public,
 * conservative limits — rather than crashing mid-event or, far worse, defaulting
 * to publishing everything unmoderated.
 */
function toPolicy(event: EventPolicyRow): EventSubmissionPolicy {
  const settings = event.settings;

  return {
    eventId: event.id,
    status: event.status as EventSubmissionPolicy['status'],
    accessMode: (settings?.accessMode ?? 'PUBLIC') as EventSubmissionPolicy['accessMode'],
    moderationMode: (settings?.moderationMode ?? 'PRE') as EventSubmissionPolicy['moderationMode'],
    attendeeIdentityMode: (settings?.attendeeIdentityMode ??
      'OPTIONAL') as EventSubmissionPolicy['attendeeIdentityMode'],
    allowAnonymousPost: settings?.allowAnonymousPost ?? true,
    minQuestionLength: settings?.minQuestionLength ?? 10,
    maxQuestionLength: settings?.maxQuestionLength ?? 500,
    submitLimitCount: settings?.submitLimitCount ?? 5,
    submitLimitWindowSeconds: settings?.submitLimitWindowSeconds ?? 60,
    profanityFilter: settings?.profanityFilter ?? true,
  };
}
