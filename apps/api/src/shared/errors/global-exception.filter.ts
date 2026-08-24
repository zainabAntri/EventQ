import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  type ErrorCode,
  type FieldError,
  type ProblemDetails,
  PROBLEM_CONTENT_TYPE,
  TRACE_ID_HEADER,
} from '@eventq/contracts';
import { DomainError, RateLimitedError } from './domain-error';

/**
 * The ONE place an exception becomes an HTTP response.
 *
 * Controllers contain no try/catch mapping. Every error — domain, framework,
 * validation or entirely unexpected — leaves through here as RFC 9457
 * problem+json, so clients only ever have to parse one error shape.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Set by the logging middleware; falls back so the field is never absent.
    const traceId = (request.headers[TRACE_ID_HEADER] as string | undefined) ?? 'unknown';

    const problem = this.toProblem(exception, request.originalUrl ?? request.url, traceId);

    this.log(exception, problem);

    if (exception instanceof RateLimitedError) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    response
      .status(problem.status)
      .setHeader('Content-Type', PROBLEM_CONTENT_TYPE)
      .setHeader(TRACE_ID_HEADER, traceId)
      .json(problem);
  }

  private toProblem(exception: unknown, instance: string, traceId: string): ProblemDetails {
    if (exception instanceof DomainError) {
      return this.problem({
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        instance,
        traceId,
        ...(exception.fieldErrors ? { errors: [...exception.fieldErrors] } : {}),
      });
    }

    // A zod failure that escaped the validation pipe.
    if (exception instanceof ZodError) {
      return this.problem({
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        detail: 'The request payload failed validation.',
        instance,
        traceId,
        errors: exception.issues.map((issue): FieldError => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return this.problem({
        status,
        code: this.codeForStatus(status),
        detail: this.detailFromHttpException(exception),
        instance,
        traceId,
      });
    }

    // Unknown failure. The client gets a traceId and nothing else — internal
    // detail is for the log, not for the wire.
    return this.problem({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred. Quote the traceId when reporting this.',
      instance,
      traceId,
    });
  }

  private problem(input: {
    status: number;
    code: ErrorCode;
    detail: string;
    instance: string;
    traceId: string;
    errors?: FieldError[];
  }): ProblemDetails {
    return {
      // A stable, dereferenceable URI per code — machine-readable and
      // documentable without inventing a second identifier scheme.
      type: `https://docs.eventq.io/errors/${input.code.toLowerCase()}`,
      title: this.titleForCode(input.code),
      status: input.status,
      code: input.code,
      detail: input.detail,
      instance: input.instance,
      traceId: input.traceId,
      ...(input.errors ? { errors: input.errors } : {}),
    };
  }

  private detailFromHttpException(exception: HttpException): string {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join('; ');
    }
    return exception.message;
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
    }
  }

  private titleForCode(code: ErrorCode): string {
    // Human-readable, stable per code. Detail varies per occurrence; this does not.
    return code
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private log(exception: unknown, problem: ProblemDetails): void {
    const meta = {
      traceId: problem.traceId,
      code: problem.code,
      status: problem.status,
      path: problem.instance,
      ...(exception instanceof DomainError && exception.context
        ? { context: exception.context }
        : {}),
    };

    // 5xx is our bug and needs a stack. 4xx is the client's input and would
    // otherwise flood the logs with noise during a spam wave.
    if (problem.status >= 500) {
      this.logger.error(meta, exception instanceof Error ? exception.stack : String(exception));
    } else {
      this.logger.debug(meta);
    }
  }
}
