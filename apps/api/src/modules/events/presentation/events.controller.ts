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
  Res,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
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
  GetEventQrCodeUseCase,
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
    private readonly getQrCode: GetEventQrCodeUseCase,
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

  @Get(':eventId/qr')
  @RequirePermissions('event:read')
  @ApiOperation({
    summary: 'QR code for the attendee page',
    description:
      "Encodes the event's joinUrl, tinted with the event's accent colour at a contrast a scanner can actually read. SVG by default, so it stays sharp on a poster or a projector wall; ?format=png for the tools that refuse SVG. ?download=1 sends it as an attachment.",
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiQuery({ name: 'format', required: false, enum: ['svg', 'png'] })
  @ApiQuery({
    name: 'download',
    required: false,
    description: 'Any truthy value sends Content-Disposition: attachment.',
  })
  @ApiProduces('image/svg+xml', 'image/png')
  @ApiResponse({ status: 200, description: 'The QR code.' })
  /**
   * `@Res()` WITHOUT passthrough, deliberately.
   *
   * With passthrough, Nest sends the returned value itself — and its Express
   * adapter serialises anything that is not a string with `res.json()`. A PNG
   * Buffer therefore went out as `{"type":"Buffer","data":[...]}` with an
   * `image/png` header on it: a 200 response that every client would fail to
   * render, and which no status-code assertion would ever catch.
   *
   * Owning the response means the bytes are written exactly as produced. Thrown
   * errors still reach the global exception filter, which is what keeps the
   * 404 for another organization's event intact.
   */
  async qrCode(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
    @Res() response: Response,
    @Query('format') format?: string,
    @Query('download') download?: string,
  ): Promise<void> {
    // An unrecognised format falls back to SVG rather than erroring. This is an
    // image in an <img> tag; a 400 here would render as a broken icon on the
    // dashboard with nothing to explain it.
    const image = await this.getQrCode.execute(eventId, context, format === 'png' ? 'png' : 'svg');

    response.setHeader('Content-Type', image.contentType);
    // Never cached by a shared proxy: the URL it encodes is only as private as
    // the event itself, and an organizer revoking access should not be undone
    // by a CDN still serving the old image.
    response.setHeader('Cache-Control', 'private, max-age=300');

    if (download) {
      // The filename is built from the join code, which is drawn from a
      // restricted alphabet — no quotes, no path separators, nothing that could
      // break out of the header.
      response.setHeader('Content-Disposition', `attachment; filename="${image.filename}"`);
    }

    response.send(image.body);
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
