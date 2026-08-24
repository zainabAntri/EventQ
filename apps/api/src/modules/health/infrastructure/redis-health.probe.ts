import { Injectable } from '@nestjs/common';
import type { HealthProbe } from '../domain/health-probe.port';
import { RedisService } from '../../../shared/redis/redis.service';

/**
 * Adds Redis to readiness — exactly the extension the port was designed for:
 * one class and one entry in the module's provider array, with no change to the
 * use-case or the controller.
 */
@Injectable()
export class RedisHealthProbe implements HealthProbe {
  readonly name = 'redis';

  constructor(private readonly redis: RedisService) {}

  check(): Promise<boolean> {
    return this.redis.isHealthy();
  }
}
