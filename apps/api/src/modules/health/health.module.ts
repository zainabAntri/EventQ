import { Module } from '@nestjs/common';
import { HealthController } from './presentation/health.controller';
import { CheckReadinessUseCase } from './application/check-readiness.use-case';
import { DatabaseHealthProbe } from './infrastructure/database-health.probe';
import { RedisHealthProbe } from './infrastructure/redis-health.probe';
import { HEALTH_PROBES } from './domain/health-probe.port';

/**
 * Reference wiring for every feature module.
 *
 * The module is the ONLY place where a domain port meets its concrete adapter.
 * That single composition point is what lets the use-case stay ignorant of
 * Prisma while still talking to a real database at runtime.
 *
 * To add Redis or S3 to readiness: write a probe implementing HealthProbe and
 * add it to the array below. Nothing else changes.
 */
@Module({
  controllers: [HealthController],
  providers: [
    CheckReadinessUseCase,
    DatabaseHealthProbe,
    RedisHealthProbe,
    {
      provide: HEALTH_PROBES,
      useFactory: (database: DatabaseHealthProbe, redis: RedisHealthProbe) => [database, redis],
      inject: [DatabaseHealthProbe, RedisHealthProbe],
    },
  ],
})
export class HealthModule {}
