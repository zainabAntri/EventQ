import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { EventInsightsResponse } from '@eventq/contracts';
import { ApiZodResponse } from '../../../shared/validation/zod-dto';
import { RequirePermissions } from '../../../shared/auth/auth.guard';
import { Ctx, type RequestContext } from '../../../shared/auth/request-context';
import { GetEventInsightsUseCase } from '../application/get-event-insights.use-case';

/**
 * Event Insights. Read-only, organizer-only, and free: no model is called
 * on this path, and nothing is recorded by reading it.
 */
@ApiTags('insights')
@Controller()
export class InsightsController {
  constructor(private readonly insights: GetEventInsightsUseCase) {}

  @Get('events/:eventId/insights')
  @RequirePermissions('question:read')
  @ApiOperation({
    summary: 'Measured facts about an event',
    description:
      'Question volume and outcomes, the follow-up list of approved questions nobody answered, engagement head-counts, submissions over time, duplicate groups, moderation wait, and words that recur across questions. Every figure is counted from questions, votes and the moderation audit trail the product already keeps — reading insights records nothing, and no model is called. AI interpretations of the same event (categories, topics, the summary) are served separately under `/ai/*` and are never mixed into this response. Returns 404 for an event owned by another organization, identical to one that does not exist.',
  })
  @ApiParam({ name: 'eventId', format: 'uuid' })
  @ApiZodResponse(200, EventInsightsResponse, 'The insights.')
  get(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Ctx() context: RequestContext,
  ): Promise<EventInsightsResponse> {
    return this.insights.execute(eventId, context);
  }
}
