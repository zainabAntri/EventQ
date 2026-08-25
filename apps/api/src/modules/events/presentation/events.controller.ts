import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  CreateEventRequest,
  DeleteEventResponse,
  EventListQuery,
  EventListResponse,
  EventResponse,
  UpdateEventRequest,
} from '@eventq/contracts';
import {
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
  createZodDto,
} from '../../../shared/validation/zod-dto';
import { RequirePermissions } from '../../../shared/auth/auth.guard';
import { Ctx, type RequestContext } from '../../../shared/auth/request-context';
import {
  ChangeEventStatusUseCase,
  CreateEventUseCase,
  DeleteEventUseCase,
  GetEventUseCase,
  ListEventsUseCase,
  UpdateEventUseCase,
} from '../application/event.use-cases';

class CreateEventDto extends createZodDto(CreateEventRequest) {}
class UpdateEventDto extends createZodDto(UpdateEventRequest) {}
class EventListQueryDto extends createZodDto(EventListQuery) {}

/**
 * Organizer event management.
 *
 * The controller never receives an organization id. Every operation takes
 * `@Ctx()` — derived from the session — and hands it to a use-case, which
 * scopes the query. A caller therefore cannot address another organization's
 * event no matter what it puts in the path or body, which is the concrete
 * answer to BOLA/IDOR.
 *
 * Authentication is applied by the globally-registered AuthGuard; this
 * controller adds the permission requirements on top.
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly createEvent: CreateEventUseCase,
    private readonly listEvents: ListEventsUseCase,
    private readonly getEvent: GetEventUseCase,
    private readonly updateEvent: UpdateEventUseCase,
    private readonly changeStatus: ChangeEventStatusUseCase,
    private readonly deleteEvent: DeleteEventUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('event:create')
  @ApiOperation({
    summary: 'Create an event',
    description:
      "Created as a DRAFT in the caller's organization. Status, join code and organization cannot be set by the client.",
  })
  @ApiZodBody(CreateEventRequest)
  @ApiZodResponse(201, EventResponse, 'Created.')
  create(@Body() body: CreateEventDto, @Ctx() context: RequestContext): Promise<EventResponse> {
    return this.createEvent.execute(body, context);
  }

  @Get()
  @RequirePermissions('event:read')
  @ApiOperation({
    summary: 'List events',
    description: "Only the caller's own organization. Archived events are never listed.",
  })
  @ApiZodQuery(EventListQuery)
  @ApiZodResponse(200, EventListResponse, 'A page of events.')
  list(
    @Query() query: EventListQueryDto,
    @Ctx() context: RequestContext,
  ): Promise<EventListResponse> {
    return this.listEvents.execute(query, context);
  }

  @Get(':eventId')
  @RequirePermissions('event:read')
  @ApiOperation({
    summary: 'Event details',
    description:
      'Reports 404 for an event owned by another organization — identical to one that does not exist, so ids cannot be probed.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventResponse, 'The event.')
  findOne(
    // Rejects a malformed id before it reaches the database, so a junk path
    // segment is a clean 400 rather than a driver-level error.
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventResponse> {
    return this.getEvent.execute(eventId, context);
  }

  @Patch(':eventId')
  @RequirePermissions('event:update')
  @ApiOperation({
    summary: 'Edit an event',
    description:
      'Partial update. Only content fields are writable; status changes have their own endpoints.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodBody(UpdateEventRequest)
  @ApiZodResponse(200, EventResponse, 'Updated.')
  update(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Body() body: UpdateEventDto,
    @Ctx() context: RequestContext,
  ): Promise<EventResponse> {
    return this.updateEvent.execute(eventId, body, context);
  }

  @Post(':eventId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('event:update')
  @ApiOperation({ summary: 'Publish an event', description: 'DRAFT -> PUBLISHED.' })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventResponse, 'Published.')
  publish(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventResponse> {
    return this.changeStatus.publish(eventId, context);
  }

  @Post(':eventId/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('event:update')
  @ApiOperation({
    summary: 'Return an event to draft',
    description:
      'Refused once anyone has participated: withdrawing it would hide their contributions. Close it instead.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventResponse, 'Returned to draft.')
  unpublish(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventResponse> {
    return this.changeStatus.unpublish(eventId, context);
  }

  @Post(':eventId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('event:update')
  @ApiOperation({
    summary: 'Close an event',
    description: 'Terminal. The event stops being publicly reachable and its content is frozen.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventResponse, 'Closed.')
  close(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventResponse> {
    return this.changeStatus.close(eventId, context);
  }

  @Delete(':eventId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('event:delete')
  @ApiOperation({
    summary: 'Delete an event',
    description:
      'Safe deletion: an untouched draft is removed permanently; anything published or participated in is archived, so attendee contributions and the audit trail survive.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, DeleteEventResponse, 'Deleted or archived.')
  remove(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<DeleteEventResponse> {
    return this.deleteEvent.execute(eventId, context);
  }
}
