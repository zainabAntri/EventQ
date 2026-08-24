import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  AuthSessionResponse,
  LoginRequest,
  REFRESH_TOKEN_COOKIE,
  RegisterRequest,
  type AuthenticatedOrganizer,
} from '@eventq/contracts';
import { ApiZodBody, ApiZodResponse, createZodDto } from '../../../shared/validation/zod-dto';
import { Public } from '../../../shared/auth/auth.guard';
import { Ctx, type RequestContext } from '../../../shared/auth/request-context';
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  RATE_LIMITER,
  RATE_LIMIT_RULES,
  type RateLimitRule,
  type RateLimiter,
} from '../../../shared/rate-limit/rate-limiter.port';
import { RateLimitedError, UnauthenticatedError } from '../../../shared/errors/domain-error';
import { RegisterOrganizerUseCase } from '../application/register-organizer.use-case';
import { LoginOrganizerUseCase } from '../application/login-organizer.use-case';
import {
  GetCurrentOrganizerUseCase,
  RefreshSessionUseCase,
  SignOutUseCase,
  StartSessionUseCase,
} from '../application/session.use-cases';
import { clearSessionCookies, setSessionCookies } from './auth.cookies';

class RegisterDto extends createZodDto(RegisterRequest) {}
class LoginDto extends createZodDto(LoginRequest) {}

/**
 * Transport only.
 *
 * Reads the request, calls a use-case, writes cookies and returns a contract
 * shape. No persistence, no token mechanics, no business rules — those live in
 * application/ and domain/, and the architecture lint rules enforce it.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerOrganizerUseCase: RegisterOrganizerUseCase,
    private readonly loginOrganizerUseCase: LoginOrganizerUseCase,
    private readonly startSession: StartSessionUseCase,
    private readonly refreshSession: RefreshSessionUseCase,
    private readonly signOutUseCase: SignOutUseCase,
    private readonly getCurrentOrganizer: GetCurrentOrganizerUseCase,
    private readonly config: AppConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register an organizer',
    description:
      'Creates the organizer, their organization and an OWNER membership atomically, then signs them in.',
  })
  @ApiZodBody(RegisterRequest)
  @ApiZodResponse(201, AuthSessionResponse, 'Registered and signed in.')
  async register(
    @Body() body: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    await this.enforceLimit(RATE_LIMIT_RULES.register, clientIp(request));

    const organizer = await this.registerOrganizerUseCase.execute(body);
    await this.issueCookies(organizer, request, response);

    return { organizer };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Rate limited per IP and, independently, per account with progressive backoff. A wrong email and a wrong password are indistinguishable.',
  })
  @ApiZodBody(LoginRequest)
  @ApiZodResponse(200, AuthSessionResponse, 'Signed in.')
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    await this.enforceLimit(RATE_LIMIT_RULES.login, clientIp(request));

    const organizer = await this.loginOrganizerUseCase.execute(body);

    // A user who mistyped once then succeeded should not stay penalised.
    await this.rateLimiter.reset(RATE_LIMIT_RULES.login, clientIp(request));
    await this.issueCookies(organizer, request, response);

    return { organizer };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the session',
    description:
      'Exchanges the refresh token for a new pair. Replaying an already-rotated token revokes the entire family.',
  })
  @ApiZodResponse(200, AuthSessionResponse, 'Session rotated.')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    await this.enforceLimit(RATE_LIMIT_RULES.refresh, clientIp(request));

    const presented = readRefreshCookie(request);
    if (!presented) throw new UnauthenticatedError('No session to refresh.');

    const { tokens, organizer } = await this.refreshSession.execute(
      presented,
      sessionContext(request),
    );
    setSessionCookies(response, this.config, tokens);

    return { organizer };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out',
    description: 'Revokes the refresh token and clears both cookies. Signing out twice is fine.',
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.signOutUseCase.execute(readRefreshCookie(request));

    // Cleared regardless of whether the token was still valid: a caller whose
    // session had already expired still wants the browser state gone.
    clearSessionCookies(response, this.config);
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in organizer' })
  @ApiZodResponse(200, AuthSessionResponse, 'The current session.')
  async me(@Ctx() context: RequestContext): Promise<AuthSessionResponse> {
    return { organizer: await this.getCurrentOrganizer.execute(context.userId, context.orgId) };
  }

  private async issueCookies(
    organizer: AuthenticatedOrganizer,
    request: Request,
    response: Response,
  ): Promise<void> {
    const tokens = await this.startSession.execute(organizer, sessionContext(request));
    setSessionCookies(response, this.config, tokens);
  }

  private async enforceLimit(rule: RateLimitRule, key: string): Promise<void> {
    const decision = await this.rateLimiter.consume(rule, key);
    if (!decision.allowed) {
      throw new RateLimitedError(
        'Too many attempts. Please wait before trying again.',
        decision.retryAfterSeconds,
      );
    }
  }
}

function readRefreshCookie(request: Request): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_TOKEN_COOKIE];
}

function sessionContext(request: Request) {
  return { userAgent: request.headers['user-agent'], ipAddress: clientIp(request) };
}

/**
 * Behind an ALB, `req.ip` is the load balancer unless `trust proxy` is set.
 * main.http.ts configures that; this reads the resolved value.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
