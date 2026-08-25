import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ATTENDEE_TOKEN_COOKIE,
  AttendeeSessionResponse,
  CursorPaginationQuery,
  IDEMPOTENCY_KEY_HEADER,
  JoinCode,
  PublicQuestionListResponse,
  PublicQuestionResponse,
  SubmitQuestionRequest,
} from '@eventq/contracts';
import {
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
  createZodDto,
} from '../../../shared/validation/zod-dto';
import { Public } from '../../../shared/auth/auth.guard';
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  RATE_LIMITER,
  RATE_LIMIT_RULES,
  type RateLimitRule,
  type RateLimiter,
} from '../../../shared/rate-limit/rate-limiter.port';
import { RateLimitedError } from '../../../shared/errors/domain-error';
import { EventNotFoundError } from '../../events/domain/event.errors';
import {
  ATTENDEE_TOKENS,
  type AttendeeTokenClaims,
  type AttendeeTokens,
} from '../domain/attendee-tokens.port';
import {
  JoinEventUseCase,
  ListPublicQuestionsUseCase,
  SubmitQuestionUseCase,
} from '../application/question.use-cases';
import { AttendeeCtx, AttendeeGuard, type AttendeeRequest } from './attendee.guard';
import { setAttendeeCookie } from './attendee.cookies';

class SubmitQuestionDto extends createZodDto(SubmitQuestionRequest) {}
class QuestionListQueryDto extends createZodDto(CursorPaginationQuery) {}

/**
 * The attendee surface.
 *
 * Kept in its own controller rather than as @Public() methods alongside the
 * organizer's, for the same reason PublicEventsController is: different
 * audience, different threat model, different response shapes. Mixing them is
 * how a field intended for organizers ends up on an endpoint printed on a
 * poster.
 *
 * Everything here is @Public() — no organizer session — but not unauthenticated:
 * the two write routes require an attendee token, and the read route requires
 * one so an attendee can see their own pending question.
 *
 * Note that CSRF is still enforced. The global AuthGuard checks the header
 * BEFORE the @Public() exemption, deliberately: a cross-site POST that made a
 * victim's browser submit a question in their name is a real attack, and being
 * unauthenticated does not make it harmless.
 */
@ApiTags('public')
@Public()
@Controller('public/events/:joinCode')
export class PublicQuestionsController {
  constructor(
    private readonly joinEvent: JoinEventUseCase,
    private readonly submitQuestion: SubmitQuestionUseCase,
    private readonly listQuestions: ListPublicQuestionsUseCase,
    private readonly config: AppConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(ATTENDEE_TOKENS) private readonly tokens: AttendeeTokens,
  ) {}

  @Post('attendee')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Join an event',
    description:
      'Mints a pseudonymous, event-scoped identity and sets it as an httpOnly cookie. No account, no password and no personal data. Presenting an existing token for this event reuses that identity rather than creating a second one.',
  })
  @ApiParam({ name: 'joinCode', example: 'EVENTQ26' })
  @ApiZodResponse(201, AttendeeSessionResponse, 'Joined.')
  async join(
    @Param('joinCode') joinCode: string,
    @Req() request: AttendeeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AttendeeSessionResponse> {
    const code = parseJoinCode(joinCode);
    await this.enforceLimit(RATE_LIMIT_RULES.attendeeJoin, clientIp(request));

    // Read WITHOUT the guard: someone joining for the first time has no token,
    // and requiring one would make the first scan impossible. An existing token
    // is honoured when present so a refresh does not mint a second identity
    // with a second submission quota.
    const existing = await this.readExistingAttendeeId(request);

    const { session, token } = await this.joinEvent.execute(code, existing);
    setAttendeeCookie(response, this.config, code, token);

    return session;
  }

  @Post('questions')
  @UseGuards(AttendeeGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a question',
    description:
      'Requires an attendee token for THIS event. The question is validated, normalised, checked for duplicates and assessed for spam server-side; its status is decided by the event and can never be set by the client. Send an Idempotency-Key to make a retry safe on unreliable venue wifi.',
  })
  @ApiParam({ name: 'joinCode', example: 'EVENTQ26' })
  @ApiZodBody(SubmitQuestionRequest)
  @ApiZodResponse(201, PublicQuestionResponse, 'Submitted.')
  async submit(
    @Param('joinCode') joinCode: string,
    @Body() body: SubmitQuestionDto,
    @AttendeeCtx() attendee: AttendeeTokenClaims,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<PublicQuestionResponse> {
    const code = parseJoinCode(joinCode);

    // Per-IP, on top of the per-attendee allowance the event configures. One
    // limit alone is not enough: per-attendee is trivially bypassed by joining
    // again, and per-IP alone would throttle a whole conference sharing one NAT.
    await this.enforceLimit(RATE_LIMIT_RULES.questionSubmitPerIp, clientIp(request));

    return this.submitQuestion.execute({
      joinCode: code,
      attendee,
      request: body,
      // Bounded before it reaches a VarChar(200) column, so an oversized header
      // is a clean rejection rather than a database error.
      idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
    });
  }

  @Get('questions')
  @UseGuards(AttendeeGuard)
  @ApiOperation({
    summary: 'The question board',
    description:
      "Approved and answered questions, plus the caller's own questions awaiting moderation. Never another attendee's unapproved question.",
  })
  @ApiParam({ name: 'joinCode', example: 'EVENTQ26' })
  @ApiZodQuery(CursorPaginationQuery)
  @ApiZodResponse(200, PublicQuestionListResponse, 'A page of questions.')
  async list(
    @Param('joinCode') joinCode: string,
    @Query() query: QuestionListQueryDto,
    @AttendeeCtx() attendee: AttendeeTokenClaims,
    @Req() request: Request,
  ): Promise<PublicQuestionListResponse> {
    const code = parseJoinCode(joinCode);
    await this.enforceLimit(RATE_LIMIT_RULES.publicRead, clientIp(request));

    return this.listQuestions.execute({ joinCode: code, attendee, query });
  }

  /**
   * Reads an attendee id from a token the device already holds, WITHOUT failing
   * when there is none.
   *
   * This route runs with no AttendeeGuard, because someone scanning for the
   * first time has no token and requiring one would make the first scan
   * impossible. So the token is verified here by hand and every failure —
   * absent, expired, forged, issued for another event — is treated identically
   * as "no token", producing a fresh identity.
   *
   * Returning the id is safe even if it came from another event's token: the
   * use-case resolves it with findByIdForEvent, which is scoped, so an id that
   * does not belong to this event yields null and a new attendee is created.
   */
  private async readExistingAttendeeId(request: AttendeeRequest): Promise<string | null> {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[ATTENDEE_TOKEN_COOKIE] ?? bearerToken(request);
    if (!token) return null;

    try {
      return (await this.tokens.verify(token)).sub;
    } catch {
      // An expired token and a first-ever scan must be indistinguishable.
      return null;
    }
  }

  private async enforceLimit(rule: RateLimitRule, key: string): Promise<void> {
    const decision = await this.rateLimiter.consume(rule, key);
    if (!decision.allowed) {
      throw new RateLimitedError(
        'Too many requests. Please wait a moment and try again.',
        decision.retryAfterSeconds,
      );
    }
  }
}

/**
 * Parses the join code rather than passing it through.
 *
 * A malformed code is simply "not found", never a distinct validation error.
 * Two different responses would let someone learn the code FORMAT from the
 * outside, narrowing a guessing attack against a 2^40 space considerably.
 */
function parseJoinCode(value: string): string {
  const parsed = JoinCode.safeParse(value);
  if (!parsed.success) throw new EventNotFoundError();

  return parsed.data;
}

/** Bounded and trimmed; anything unusable becomes "no key" rather than an error. */
function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 200) return undefined;

  return trimmed;
}

/**
 * Behind an ALB, `req.ip` is the load balancer unless `trust proxy` is set.
 * main.http.ts configures that; this reads the resolved value.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

/** Bearer is accepted for non-browser clients; browsers always use the cookie. */
function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}
