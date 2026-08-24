import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from './shared/validation/zod-validation.pipe';
import { AppConfigModule } from './shared/config/config.module';
import { AppLoggerModule } from './shared/logger/logger.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { GlobalExceptionFilter } from './shared/errors/global-exception.filter';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root.
 *
 * This is a modular monolith: feature modules are independently wired and talk
 * to each other through explicit interfaces, not shared internals. If the
 * Intelligence context ever needs its own deployment, extracting it is a
 * packaging change rather than a rewrite.
 *
 * Feature modules are added here as they are built. Shared infrastructure
 * (config, logging, database) is global because it is genuinely cross-cutting.
 */
@Module({
  imports: [
    // Shared infrastructure
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,

    // Features
    HealthModule,
  ],
  providers: [
    {
      // Registered globally so no controller ever has to map an error itself.
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      // Global, but opt-in per parameter: a parameter with no zod schema passes
      // through untouched, so nothing is silently coerced behind your back.
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
  ],
})
export class AppModule {}
