import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JoinCode, PublicEventResponse } from '@eventq/contracts';
import { ApiZodResponse } from '../../../shared/validation/zod-dto';
import { Public } from '../../../shared/auth/auth.guard';
import { GetPublicEventUseCase } from '../application/event.use-cases';
import { EventNotFoundError } from '../domain/event.errors';

/**
 * The attendee-facing surface: one unauthenticated read, by join code.
 *
 * Kept in its own controller rather than as a @Public() method on the organizer
 * controller. The two have different audiences, different threat models and
 * different response shapes, and mixing them is how a field intended for
 * organizers ends up on a public endpoint.
 */
@ApiTags('public')
@Public()
@Controller('public/events')
export class PublicEventsController {
  constructor(private readonly getPublicEvent: GetPublicEventUseCase) {}

  @Get(':joinCode')
  @ApiOperation({
    summary: 'Look up an event by its public identifier',
    description:
      'Returns 404 for an unknown code, a draft, a closed or archived event, and a PRIVATE one. All indistinguishable, so the endpoint cannot be used to probe for valid codes.',
  })
  @ApiParam({ name: 'joinCode', example: 'EVENTQ26' })
  @ApiZodResponse(200, PublicEventResponse, 'The event.')
  async findByJoinCode(@Param('joinCode') joinCode: string): Promise<PublicEventResponse> {
    // Parsed rather than passed through: a malformed code is simply not found,
    // which avoids leaking a distinct validation error for a public lookup.
    const parsed = JoinCode.safeParse(joinCode);
    if (!parsed.success) throw new EventNotFoundError();

    return this.getPublicEvent.execute(parsed.data);
  }
}
