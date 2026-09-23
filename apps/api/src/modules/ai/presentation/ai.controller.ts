import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  AiStatusResponse,
  CategorizeResponse,
  CategoryBreakdownResponse,
  ClusterResponse,
  EventSummaryResponse,
  LatestSummaryResponse,
  SimilarQuestionsResponse,
  SuggestedAnswerResponse,
  TopicResponse,
} from '@eventq/contracts';
import { z } from 'zod';
import { ApiZodResponse } from '../../../shared/validation/zod-dto';
import { RequirePermissions } from '../../../shared/auth/auth.guard';
import { Ctx, type RequestContext } from '../../../shared/auth/request-context';
import {
  CategorizeQuestionsUseCase,
  ClusterQuestionsUseCase,
  FindSimilarQuestionUseCase,
  GetAiStatusUseCase,
  GetCategoryBreakdownUseCase,
  GetLatestSummaryUseCase,
  ListTopicsUseCase,
  SuggestAnswerUseCase,
  SummarizeEventUseCase,
} from '../application/ai.use-cases';

/**
 * The AI surface. Organizer-only, deliberate, and never automatic.
 *
 * Every write here is a POST an organizer chose to make, gated by `ai:run`,
 * by the server switch and by the event switch. There is no attendee route
 * in this controller and no background trigger anywhere else: the product
 * makes zero model calls until a person with permission clicks a button
 * whose cost is shown next to it.
 *
 * Every response is a SUGGESTION. Nothing here changes a question's status,
 * publishes an answer, or appears on the attendee board.
 */
@ApiTags('ai')
@Controller()
export class AiController {
  constructor(
    private readonly status: GetAiStatusUseCase,
    private readonly categorize: CategorizeQuestionsUseCase,
    private readonly similar: FindSimilarQuestionUseCase,
    private readonly cluster: ClusterQuestionsUseCase,
    private readonly topics: ListTopicsUseCase,
    private readonly answer: SuggestAnswerUseCase,
    private readonly summarize: SummarizeEventUseCase,
    private readonly latestSummary: GetLatestSummaryUseCase,
    private readonly categories: GetCategoryBreakdownUseCase,
  ) {}

  @Get('events/:eventId/ai/status')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'AI status for an event',
    description:
      'Whether AI is available on the server and switched on for the event, spend so far against the per-event and monthly caps, calls made by feature, and the model each feature would use. Shown before any AI button is offered, so the cost is never a surprise.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, AiStatusResponse, 'Status.')
  getStatus(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<AiStatusResponse> {
    return this.status.execute(eventId, context);
  }

  @Post('events/:eventId/ai/categorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:run')
  @ApiOperation({
    summary: 'Categorize uncategorized questions',
    description:
      'One batch of up to 50 questions with no category yet, in one model call. Each is assigned one of a fixed set (Business, Marketing, Finance, Technology, AI, Networking, Operations, Other); a reply outside the set is discarded and counted as rejected. Repeat until `remaining` is zero. Refuses with AI_DISABLED unless AI is on at the server and for the event, AI_BUDGET_EXCEEDED if the call would cross a cap, AI_BUSY if the same action is already running.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, CategorizeResponse, 'Batch result.')
  runCategorize(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<CategorizeResponse> {
    return this.categorize.execute(eventId, context);
  }

  @Get('events/:eventId/ai/categories')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'How the stored categories break down',
    description:
      'Counts of live questions per category, as assigned by earlier categorize runs, with how many are still uncategorized and which models assigned them. Calls no model and costs nothing. The counts are exact; each category is a model’s judgement, and the dashboard presents it as AI interpretation, not as a fact about the questions.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, CategoryBreakdownResponse, 'The breakdown.')
  getCategories(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<CategoryBreakdownResponse> {
    return this.categories.execute(eventId, context);
  }

  @Post('questions/:questionId/ai/similar')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:run')
  @ApiOperation({
    summary: 'Ask whether a question repeats an existing one',
    description:
      'The model judges the question against the twenty nearest live questions on its event and may name one as the same question. A match is written as the SAME duplicate suggestion the deterministic detector produces, so it flows into the existing Merge / Not-a-duplicate confirmation — nothing is merged. Never overwrites a suggestion a moderator already dismissed.',
  })
  @ApiParam({ name: 'questionId', format: 'uuid' })
  @ApiZodResponse(200, SimilarQuestionsResponse, 'The suggestion, if any.')
  runSimilar(
    @Param('questionId', new ParseUUIDPipe({ version: '7' })) questionId: string,
    @Ctx() context: RequestContext,
  ): Promise<SimilarQuestionsResponse> {
    return this.similar.execute(questionId, context);
  }

  @Post('events/:eventId/ai/cluster')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:run')
  @ApiOperation({
    summary: 'Group the event’s questions into topics',
    description:
      'Up to 200 live questions in one call, grouped into labelled topics. Replaces the event’s previous topics. A question the model places by an invalid reference, or a topic with fewer than two valid questions, is dropped rather than stored.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, ClusterResponse, 'The topics.')
  runCluster(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<ClusterResponse> {
    return this.cluster.execute(eventId, context);
  }

  @Get('events/:eventId/ai/topics')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'The event’s current topics',
    description: 'From the last clustering run.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, z.array(TopicResponse), 'Topics.')
  listTopics(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<TopicResponse[]> {
    return this.topics.execute(eventId, context);
  }

  @Post('questions/:questionId/ai/suggest-answer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:run')
  @ApiOperation({
    summary: 'Draft an answer for the organizer to review',
    description:
      'A DRAFT, stored on the question’s enrichment record with the model’s own caveats, for a person to read, edit or discard. It is never shown to attendees and never becomes an answer on its own. The model is given the event title, description and the question text — no attendee information.',
  })
  @ApiParam({ name: 'questionId', format: 'uuid' })
  @ApiZodResponse(200, SuggestedAnswerResponse, 'The draft.')
  runSuggestAnswer(
    @Param('questionId', new ParseUUIDPipe({ version: '7' })) questionId: string,
    @Ctx() context: RequestContext,
  ): Promise<SuggestedAnswerResponse> {
    return this.answer.execute(questionId, context);
  }

  @Post('events/:eventId/ai/summary')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:run')
  @ApiOperation({
    summary: 'Summarise what the audience wanted to know',
    description:
      'Up to 200 live questions in one call. LIVE while the event is published, FINAL once it has closed. Question references in the summary are validated against the questions actually sent.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventSummaryResponse, 'The summary.')
  runSummary(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventSummaryResponse> {
    return this.summarize.execute(eventId, context);
  }

  @Get('events/:eventId/ai/summary')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'The latest stored summary',
    description: 'Null when none has been generated.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, LatestSummaryResponse, 'The latest summary, or null.')
  getSummary(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<LatestSummaryResponse> {
    return this.latestSummary.execute(eventId, context);
  }
}
