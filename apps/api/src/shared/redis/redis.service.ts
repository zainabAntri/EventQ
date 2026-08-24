import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

/**
 * Redis connection.
 *
 * Redis is treated as REBUILDABLE throughout EventQ: it holds rate-limit
 * counters and, later, realtime fan-out. Nothing that cannot be reconstructed
 * lives here — Postgres is the durable source of truth.
 *
 * Consequence: the app must survive Redis being down. See RedisRateLimiter for
 * how that is handled without silently disabling a security control.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.redisUrl, {
      // Fail fast rather than queueing commands forever behind a dead server:
      // a request should get an answer, not hang until the client times out.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    // ioredis emits 'error' on every reconnect attempt; without a listener,
    // Node treats it as an unhandled error event and kills the process.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis unavailable: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Redis connection established');
    } catch (error) {
      // Deliberately non-fatal. Redis being down degrades the service; it does
      // not justify refusing to start and taking the whole API offline.
      this.logger.error(
        `Redis unavailable at startup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
