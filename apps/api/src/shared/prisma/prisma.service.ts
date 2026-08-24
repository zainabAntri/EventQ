import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service';

/**
 * Prisma client lifecycle.
 *
 * Prisma 7 constructs the client with a driver adapter rather than reading a
 * connection URL from the schema, so the pool is configured here in application
 * code where it can be tuned per environment.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    const adapter = new PrismaPg({
      connectionString: config.databaseUrl,
      // A live event is a burst of short queries, not a few long ones. Keeping
      // the pool modest per task and scaling tasks horizontally protects RDS
      // from connection exhaustion, which is the usual failure mode when an
      // API autoscales without a connection budget.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    super({
      adapter,
      log: config.isProduction
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Liveness probe for the readiness endpoint.
   *
   * `SELECT 1` rather than a table read: it proves the connection works without
   * coupling health to any particular schema object.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database health check failed', error);
      return false;
    }
  }
}
