import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger, RequestMethod } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';
import { OPENAPI_PATH, setupOpenApi } from './shared/openapi/setup-openapi';

/**
 * HTTP entrypoint.
 *
 * The worker process (main.worker.ts) boots the SAME modules with no HTTP
 * server, so background jobs and request handlers share one implementation of
 * every use-case rather than drifting into two.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Defer logging to pino so startup lines are structured too.
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfigService);

  // Behind an ALB, req.ip is the load balancer without this, which would make
  // every request share one rate-limit bucket. Set to 1 rather than `true`:
  // trusting the whole chain lets a client forge X-Forwarded-For and evade
  // limiting entirely.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON, never HTML, so a restrictive default CSP is free.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // HSTS is meaningful only where TLS terminates in front of us.
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    }),
  );

  app.use(cookieParser());

  /**
   * An explicit, small ceiling on request bodies.
   *
   * Express defaults to 100 kB, which is generous for an API whose largest
   * legitimate payload is a 500-character question. The limit is stated here
   * rather than left implicit because it is a real control on a public,
   * unauthenticated endpoint: a body is buffered in memory BEFORE any
   * validation runs, so zod's length rules cannot protect against a large one.
   * Rejecting at the transport layer is the only place that can.
   */
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  /**
   * CORS for the Vercel <-> AWS split.
   *
   * `credentials: true` is what allows the session cookie to travel, and it is
   * why the origin list must be exact — the browser rejects a wildcard on a
   * credentialed request. The web app and the API sit on sibling subdomains of
   * one registrable domain so the cookies are same-site rather than
   * third-party, which is the design decision that makes this work at all.
   */
  app.enableCors({
    origin: config.http.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Idempotency-Key',
      'X-Trace-Id',
      'Authorization',
      // The CSRF header. A cross-site request cannot send it without passing a
      // preflight against this exact allowlist.
      'X-EventQ-Client',
    ],
    exposedHeaders: ['X-Trace-Id', 'Retry-After'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix('api/v1', {
    // Probes stay off the version prefix: the load balancer's health check URL
    // must not move when the API version does. RouteInfo form rather than bare
    // strings — Express 5's path-to-regexp rejects the legacy wildcard syntax
    // Nest would otherwise synthesise.
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });

  // Must come after setGlobalPrefix so documented paths match real ones.
  setupOpenApi(app, config);

  // Let in-flight requests finish and SSE streams close cleanly on deploy.
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  NestLogger.log(
    `EventQ API listening on port ${config.port} [${config.nodeEnv}] | AI: ${config.ai.enabled ? 'enabled' : 'disabled'}`,
    'Bootstrap',
  );
  if (!config.isProduction) {
    NestLogger.log(`OpenAPI docs at ${config.http.publicUrl}/${OPENAPI_PATH}`, 'Bootstrap');
  }
}

void bootstrap();
