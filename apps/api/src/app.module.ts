import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AppConfigModule } from './shared/config/config.module';
import { AppLoggerModule } from './shared/logger/logger.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { RateLimitModule } from './shared/rate-limit/rate-limit.module';
import { GlobalExceptionFilter } from './shared/errors/global-exception.filter';
import { ZodValidationPipe } from './shared/validation/zod-validation.pipe';
import { AuthGuard } from './shared/auth/auth.guard';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';

/**
 * Composition root.
 *
 * A modular monolith: feature modules are independently wired and talk to each
 * other through explicit interfaces, not shared internals.
 */
@Module({
  imports: [
    // Shared infrastructure
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    RateLimitModule,

    // Features
    HealthModule,
    AuthModule,
    EventsModule,
  ],
  providers: [
    {
      // Registered globally so no controller ever maps an error itself.
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      // Global, but opt-in per parameter: a parameter with no zod schema passes
      // through untouched, so nothing is silently coerced.
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      // Global, and this direction matters: every route requires authentication
      // unless it explicitly opts out with @Public(). The reverse arrangement
      // makes one forgotten decorator an open endpoint, which review does not
      // reliably catch.
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
