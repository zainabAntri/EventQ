import { Inject, Injectable } from '@nestjs/common';
import { toString as renderQrCode } from 'qrcode';
import type {
  CreateEventRequest,
  DeleteEventResponse,
  EventListQuery,
  EventListResponse,
  EventResponse,
  PublicEventResponse,
  UpdateEventRequest,
} from '@eventq/contracts';
import type { RequestContext } from '../../../shared/auth/request-context';
// Configuration is a shared cross-cutting concern, not infrastructure: the
// layer rules forbid application/ from reaching for Prisma or HTTP, and this is
// neither. The alternative — building the join URL in each controller — would
// scatter one fact across several places.
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  EVENT_REPOSITORY,
  type EventRecord,
  type EventRepository,
  type UpdateEventData,
} from '../domain/event.repository';
import {
  EventHasParticipationError,
  EventNotEditableError,
  EventNotFoundError,
  InvalidEventDatesError,
  InvalidEventTransitionError,
  JoinCodeUnavailableError,
} from '../domain/event.errors';
import {
  canTransition,
  canUnpublish,
  isEditable,
  isPubliclyVisible,
  resolveDeletion,
} from '../domain/event-lifecycle';
import { generateJoinCode, joinUrlFor, slugifyTitle } from '../domain/join-code';
import { CODE_GENERATOR, type CodeGenerator } from '../domain/code-generator.port';
import { toEventResponse, toPublicEventResponse } from './event.mapper';

/**
 * Every use-case here takes a RequestContext and passes `context.orgId` to the
 * repository. The organization is ALWAYS derived from the session, never from
 * the request body or a path parameter — that is the difference between an
 * authorization check and an IDOR vulnerability.
 */

/** Loads an event the caller is entitled to, or reports it as missing. */
@Injectable()
export class FindEventForOrganizerUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly events: EventRepository) {}

  async execute(eventId: string, context: RequestContext): Promise<EventRecord> {
    const event = await this.events.findByIdForOrg(eventId, context.orgId);

    // Identical outcome whether the event does not exist or belongs to another
    // organization. Distinguishing them would confirm which ids are real.
    if (!event || event.status === 'ARCHIVED') throw new EventNotFoundError();

    return event;
  }
}

@Injectable()
export class GetEventUseCase {
  constructor(
    private readonly find: FindEventForOrganizerUseCase,
    private readonly config: AppConfigService,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<EventResponse> {
    return toEventResponse(await this.find.execute(eventId, context), this.config.http.webOrigin);
  }
}

/**
 * The QR code an attendee scans.
 *
 * Rendered here rather than behind a port, unlike CODE_GENERATOR: that one is
 * injected because randomness must be made deterministic for a test, whereas
 * this is a pure, deterministic transformation of a string. A port would be
 * ceremony with nothing behind it.
 *
 * SVG rather than PNG, because this ends up printed on A3 posters and thrown at
 * projector walls. A raster image has to guess a resolution and will be wrong
 * for one of those; vectors are sharp at every size and are a fraction of the
 * bytes.
 */
@Injectable()
export class GetEventQrCodeUseCase {
  constructor(
    private readonly find: FindEventForOrganizerUseCase,
    private readonly config: AppConfigService,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<string> {
    // Goes through the same org-scoped lookup as every other read, so an event
    // belonging to another organization is a 404 here too. A QR endpoint that
    // skipped that check would happily render a code for someone else's event.
    const event = await this.find.execute(eventId, context);

    return renderQrCode(joinUrlFor(this.config.http.webOrigin, event.joinCode), {
      type: 'svg',
      // Medium error correction. A QR on a poster gets scuffed, partly covered
      // and photographed at an angle; 'L' would fail in a real room, and 'H'
      // would make the code denser than a phone camera can resolve from the
      // back row for no benefit at this payload size.
      errorCorrectionLevel: 'M',
      margin: 2,
    });
  }
}

@Injectable()
export class ListEventsUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    private readonly config: AppConfigService,
  ) {}

  async execute(query: EventListQuery, context: RequestContext): Promise<EventListResponse> {
    const page = await this.events.findManyForOrg({
      orgId: context.orgId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });

    return {
      items: page.items.map((event) => toEventResponse(event, this.config.http.webOrigin)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}

@Injectable()
export class CreateEventUseCase {
  /** Bounded retries on join-code collision. At 2^40 codes a clash is already
   *  improbable; an unbounded loop would be a hang waiting to happen. */
  private static readonly MAX_CODE_ATTEMPTS = 5;

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    @Inject(CODE_GENERATOR) private readonly codes: CodeGenerator,
    private readonly config: AppConfigService,
  ) {}

  async execute(request: CreateEventRequest, context: RequestContext): Promise<EventResponse> {
    const created = await this.events.create({
      orgId: context.orgId,
      // From the session, so an event can never be attributed to someone else.
      createdById: context.userId,
      title: request.title,
      description: request.description,
      venue: request.venue,
      type: request.type,
      startsAt: request.startsAt ? new Date(request.startsAt) : undefined,
      endsAt: request.endsAt ? new Date(request.endsAt) : undefined,
      timezone: request.timezone,
      settings: request.settings,
      isPubliclyListed: request.settings?.isPubliclyListed,
      ...(await this.allocateIdentifiers(context.orgId, request.title)),
    });

    return toEventResponse(created, this.config.http.webOrigin);
  }

  private async allocateIdentifiers(orgId: string, title: string) {
    let joinCode: string | null = null;

    for (let attempt = 0; attempt < CreateEventUseCase.MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = generateJoinCode(this.codes.randomBytes);
      if (!(await this.events.joinCodeExists(candidate))) {
        joinCode = candidate;
        break;
      }
    }
    if (!joinCode) throw new JoinCodeUnavailableError();

    // Slugs are unique per organization, so two organizations may both run an
    // "Annual Summit" without either being forced to rename.
    const base = slugifyTitle(title);
    let slug = base;
    for (let attempt = 2; await this.events.slugExistsInOrg(orgId, slug); attempt += 1) {
      slug = `${base}-${attempt}`;
      if (attempt > 50) {
        slug = `${base}-${joinCode.toLowerCase()}`;
        break;
      }
    }

    return { joinCode, slug };
  }
}

@Injectable()
export class UpdateEventUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    private readonly find: FindEventForOrganizerUseCase,
    private readonly config: AppConfigService,
  ) {}

  async execute(
    eventId: string,
    request: UpdateEventRequest,
    context: RequestContext,
  ): Promise<EventResponse> {
    const event = await this.find.execute(eventId, context);

    // A closed event is a record of something that happened; rewriting it after
    // the fact would make that record untrustworthy.
    if (!isEditable(event.status)) throw new EventNotEditableError(event.status);

    // The end date is validated against whichever start date will be in effect
    // after this update, not just the one in the payload — otherwise moving the
    // start past an untouched end date would slip through.
    const nextStart = resolveDate(request.startsAt, event.startsAt);
    const nextEnd = resolveDate(request.endsAt, event.endsAt);
    if (nextStart && nextEnd && nextEnd <= nextStart) {
      throw new InvalidEventDatesError();
    }

    const data: UpdateEventData = {
      title: request.title,
      description: request.description,
      venue: request.venue,
      type: request.type,
      startsAt: request.startsAt === undefined ? undefined : nextStart,
      endsAt: request.endsAt === undefined ? undefined : nextEnd,
      timezone: request.timezone,
      settings: request.settings,
      isPubliclyListed: request.settings?.isPubliclyListed,
    };

    return toEventResponse(
      await this.events.update(eventId, context.orgId, data),
      this.config.http.webOrigin,
    );
  }
}

@Injectable()
export class ChangeEventStatusUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    private readonly find: FindEventForOrganizerUseCase,
    private readonly config: AppConfigService,
  ) {}

  async publish(eventId: string, context: RequestContext): Promise<EventResponse> {
    const event = await this.find.execute(eventId, context);
    this.assertTransition(event, 'PUBLISHED');

    return toEventResponse(
      await this.events.setStatus(eventId, context.orgId, 'PUBLISHED', {
        // Preserved on re-publish so the first publication date is not lost.
        publishedAt: event.publishedAt ?? new Date(),
        closedAt: null,
      }),
      this.config.http.webOrigin,
    );
  }

  async unpublish(eventId: string, context: RequestContext): Promise<EventResponse> {
    const event = await this.find.execute(eventId, context);
    this.assertTransition(event, 'DRAFT');

    const participants = await this.events.countParticipants(eventId);
    if (!canUnpublish(event.status, participants)) {
      throw new EventHasParticipationError(participants);
    }

    return toEventResponse(
      await this.events.setStatus(eventId, context.orgId, 'DRAFT'),
      this.config.http.webOrigin,
    );
  }

  async close(eventId: string, context: RequestContext): Promise<EventResponse> {
    const event = await this.find.execute(eventId, context);
    this.assertTransition(event, 'CLOSED');

    return toEventResponse(
      await this.events.setStatus(eventId, context.orgId, 'CLOSED', { closedAt: new Date() }),
      this.config.http.webOrigin,
    );
  }

  private assertTransition(event: EventRecord, to: EventRecord['status']): void {
    if (!canTransition(event.status, to)) {
      throw new InvalidEventTransitionError(event.status, to);
    }
  }
}

@Injectable()
export class DeleteEventUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    private readonly find: FindEventForOrganizerUseCase,
  ) {}

  async execute(eventId: string, context: RequestContext): Promise<DeleteEventResponse> {
    const event = await this.find.execute(eventId, context);
    const participantCount = await this.events.countParticipants(eventId);

    const outcome = resolveDeletion({
      status: event.status,
      publishedAt: event.publishedAt,
      participantCount,
    });

    if (outcome === 'deleted') {
      await this.events.hardDelete(eventId, context.orgId);
    } else {
      // Archive rather than cascade-delete: a real event's attendee
      // contributions and audit trail are not the organizer's to erase from a
      // confirmation dialog.
      await this.events.setStatus(eventId, context.orgId, 'ARCHIVED');
    }

    return { outcome };
  }
}

/** Unauthenticated lookup by public identifier. */
@Injectable()
export class GetPublicEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly events: EventRepository) {}

  async execute(joinCode: string): Promise<PublicEventResponse> {
    const event = await this.events.findByJoinCode(joinCode);

    // Unknown code, draft, closed, archived and PRIVATE all produce the same
    // 404. Any distinction would let someone probe for valid codes or learn
    // that an event exists before its organizer chose to reveal it.
    if (!event || !isPubliclyVisible(event.status, event.settings.accessMode)) {
      throw new EventNotFoundError();
    }

    return toPublicEventResponse(event);
  }
}

/** `undefined` leaves a date untouched; `null` clears it. */
function resolveDate(incoming: string | null | undefined, current: Date | null): Date | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  return new Date(incoming);
}
