import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type OrgRole,
  type Permission,
  roleHasPermission,
} from '@eventq/contracts';
import { SESSION_TOKENS, type SessionTokens } from '../../modules/auth/domain/session-tokens.port';
import { ForbiddenError, UnauthenticatedError } from '../errors/domain-error';
import type { AuthenticatedRequest } from './request-context';

export const IS_PUBLIC_KEY = 'eventq:public-route';
export const PERMISSIONS_KEY = 'eventq:required-permissions';

/** Marks a route as reachable without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Declares the permissions a route requires. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Authentication and permission enforcement.
 *
 * Registered globally, so routes are protected BY DEFAULT and must opt out with
 * @Public(). The opposite arrangement — opt in with a guard — means one
 * forgotten decorator is an unauthenticated endpoint, and that mistake is
 * invisible in review.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // Injected as the PORT, so the guard never learns which implementation
    // verifies its tokens.
    @Inject(SESSION_TOKENS) private readonly tokens: SessionTokens,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const handler = executionContext.getHandler();
    const controller = executionContext.getClass();

    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();

    // CSRF is checked BEFORE the public-route exemption, deliberately.
    // Login and logout are public but still state-changing: forcing a victim's
    // browser to sign in as the attacker, or silently signing them out, are
    // real attacks. Exempting public routes would leave both open.
    this.assertCsrfHeader(request);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler,
      controller,
    ]);
    if (isPublic) return true;

    const token = this.readAccessToken(request);
    if (!token) throw new UnauthenticatedError('Authentication required.');

    const claims = await this.tokens.verifyAccessToken(token);

    request.context = {
      userId: claims.sub,
      orgId: claims.org,
      role: claims.role as OrgRole,
    };

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      handler,
      controller,
    ]);

    if (required?.length) {
      const missing = required.filter(
        (permission) => !roleHasPermission(request.context!.role, permission),
      );
      if (missing.length > 0) {
        throw new ForbiddenError(
          `Your role does not permit this action (requires: ${missing.join(', ')}).`,
          { context: { role: request.context.role, missing } },
        );
      }
    }

    return true;
  }

  /**
   * CSRF defence, layered on top of SameSite=Lax cookies.
   *
   * A cross-site form POST cannot set a custom header, and a cross-origin XHR
   * that tries to must first pass a CORS preflight that our allowlist rejects.
   * Safe methods are exempt because they must not change state anyway.
   */
  private assertCsrfHeader(request: AuthenticatedRequest): void {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    if (request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new ForbiddenError(
        `Missing or invalid ${CSRF_HEADER} header on a state-changing request.`,
      );
    }
  }

  private readAccessToken(request: AuthenticatedRequest): string | undefined {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const fromCookie = cookies?.[ACCESS_TOKEN_COOKIE];
    if (fromCookie) return fromCookie;

    // Bearer is accepted for non-browser clients (CI, integration tests,
    // future server-to-server use). Browsers always use the cookie, which is
    // httpOnly and therefore unreadable by an XSS payload.
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

    return undefined;
  }
}
