import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ModerateQuestionRequest,
  ModerationQueueQuery,
  ModerationQueueResponse,
  QuestionResponse,
  QuestionStatsResponse,
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
  GetQuestionStatsUseCase,
  ListModerationQueueUseCase,
  ModerateQuestionUseCase,
} from '../application/question.use-cases';

class ModerationQueueQueryDto extends createZodDto(ModerationQueueQuery) {}
class ModerateQuestionDto extends createZodDto(ModerateQuestionRequest) {}

/**
 * Organizer moderation.
 *
 * The controller never receives an organization id. Every operation takes
 * `@Ctx()` — derived from the session — and hands it to a use-case, which
 * scopes the query. A moderator therefore cannot act on another organization's
 * question no matter what they put in the path.
 *
 * Authentication comes from the globally-registered AuthGuard; this adds the
 * permission requirements on top.
 */
@ApiTags('questions')
@Controller()
export class QuestionsController {
  constructor(
    private readonly listQueue: ListModerationQueueUseCase,
    private readonly stats: GetQuestionStatsUseCase,
    private readonly moderate: ModerateQuestionUseCase,
  ) {}

  @Get('events/:eventId/questions')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'The moderation queue',
    description:
      'Cursor-paginated. Filter with `status`, search the question text with `search`, and order with `sort` (rank, newest, oldest, votes) — `rank` is the default and blends attendee votes, recency, organizer priority and moderation status into the `rankScore` returned on every item. Archived questions are soft-deleted and appear only when `status=ARCHIVED` is requested by name. Each item carries `allowedActions`, the moderation actions legal from its current state. Returns an empty page for an event owned by another organization — identical to one with no questions, so ids cannot be probed.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodQuery(ModerationQueueQuery)
  @ApiZodResponse(200, ModerationQueueResponse, 'A page of questions.')
  list(
    // Rejects a malformed id before it reaches the database, so a junk path
    // segment is a clean 400 rather than a driver-level error.
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Query() query: ModerationQueueQueryDto,
    @Ctx() context: RequestContext,
  ): Promise<ModerationQueueResponse> {
    return this.listQueue.execute(eventId, query, context);
  }

  @Get('events/:eventId/questions/stats')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'Question counts for an event',
    description:
      'Counts by status, plus an opaque `version` that changes whenever anything about the questions on an event changes. Intended to be polled: a dashboard watches `version` and re-runs the far heavier queue query only when it moves. This endpoint is why EventQ has no realtime transport on the organizer surface. WebSockets would carry nothing upward, because every organizer action is an ordinary REST call; and SSE, although the protocol is already specified in @eventq/contracts for the projector view, would need Redis fan-out across API instances, per-connection authentication, per-event subscription authorization, heartbeats and a stale-connection reaper. All of that to deliver a question to a moderation queue a few seconds sooner, where seconds are invisible. One grouped count over an indexed column buys the same result, and it also fills the count badges on the dashboard tabs, which a stream would not. Returns all zeros for an event owned by another organization, identical to one with no questions.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, QuestionStatsResponse, 'Counts and a change token.')
  getStats(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<QuestionStatsResponse> {
    return this.stats.execute(eventId, context);
  }

  @Post('questions/:questionId/moderate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('question:moderate')
  @ApiOperation({
    summary: 'Moderate a question',
    description:
      'Takes an ACTION (approve, reject, spam, answer, archive, restore), never a target status. The server resolves the action to a destination state and refuses it unless that state is reachable from the one the question is actually in — so a stale dashboard cannot approve something already archived. Every decision appends an immutable audit row in the same transaction.',
  })
  @ApiParam({ name: 'questionId', format: 'uuid' })
  @ApiZodBody(ModerateQuestionRequest)
  @ApiZodResponse(200, QuestionResponse, 'Moderated.')
  applyModeration(
    @Param('questionId', new ParseUUIDPipe({ version: '7' })) questionId: string,
    @Body() body: ModerateQuestionDto,
    @Ctx() context: RequestContext,
  ): Promise<QuestionResponse> {
    return this.moderate.execute(questionId, body, context);
  }
}
