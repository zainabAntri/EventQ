import { Injectable } from '@nestjs/common';
import type { HealthProbe } from '../domain/health-probe.port';
import { PrismaService } from '../../../shared/prisma/prisma.service';

/**
 * Adapter: implements the domain's HealthProbe port using Prisma.
 *
 * Infrastructure is the only layer allowed to know Prisma exists. Swapping the
 * database, or adding a Redis probe alongside this one, touches nothing outside
 * this folder and the module's provider list.
 */
@Injectable()
export class DatabaseHealthProbe implements HealthProbe {
  readonly name = 'database';

  constructor(private readonly prisma: PrismaService) {}

  check(): Promise<boolean> {
    return this.prisma.isHealthy();
  }
}
