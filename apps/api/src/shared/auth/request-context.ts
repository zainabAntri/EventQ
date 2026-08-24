import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgRole } from '@eventq/contracts';

/**
 * The authenticated caller, established once by AuthGuard.
 *
 * Every authorization decision reads from here. Nothing downstream may take an
 * organization id from the request body or a query parameter — that is exactly
 * how BOLA/IDOR bugs happen. The org is derived from the SESSION, never from
 * client input.
 */
export interface RequestContext {
  readonly userId: string;
  readonly orgId: string;
  readonly role: OrgRole;
}

export interface AuthenticatedRequest extends Request {
  context?: RequestContext;
}

/** Injects the RequestContext into a controller parameter. */
export const Ctx = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): RequestContext => {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.context) {
      // Only reachable if a controller forgot @UseGuards(AuthGuard). Failing
      // loudly beats handing a route an undefined identity.
      throw new Error('RequestContext is missing. Is AuthGuard applied to this route?');
    }
    return request.context;
  },
);
