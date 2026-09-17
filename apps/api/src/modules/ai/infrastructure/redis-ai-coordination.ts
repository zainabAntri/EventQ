import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../shared/redis/redis.service';
import type { AiCoordination } from '../domain/ai.repository';

/**
 * Redis-backed cache and lock for AI calls.
 *
 * Both fail OPEN, and that is a considered choice rather than laziness. The
 * lock exists to stop a double-click becoming a double bill; if Redis is
 * down, the worst case is one extra call, bounded by the budget check that
 * runs against Postgres regardless. The cache exists to make a repeat free;
 * if it is down, a repeat costs what it would have cost anyway. Neither is
 * worth telling an organizer "AI is unavailable" over — the rate limiter
 * fails closed for auth because an attacker benefits from that outage; here
 * nobody does.
 */
@Injectable()
export class RedisAiCoordination implements AiCoordination {
  private readonly logger = new Logger(RedisAiCoordination.name);

  constructor(private readonly redis: RedisService) {}

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      // SET NX EX: atomic "create only if absent, with an expiry". The expiry
      // is what stops a crashed request holding the lock forever.
      const result = await this.redis.client.set(this.key(key), '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.warn('lock', error);
      return true;
    }
  }

  async releaseLock(key: string): Promise<void> {
    try {
      await this.redis.client.del(this.key(key));
    } catch (error) {
      // The TTL will release it. Not worth failing a completed call over.
      this.warn('unlock', error);
    }
  }

  async getCached(key: string): Promise<string | null> {
    try {
      return await this.redis.client.get(this.key(key));
    } catch (error) {
      this.warn('cache read', error);
      return null;
    }
  }

  async setCached(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.client.set(this.key(key), value, 'EX', ttlSeconds);
    } catch (error) {
      this.warn('cache write', error);
    }
  }

  private key(key: string): string {
    return `eventq:${key}`;
  }

  private warn(operation: string, error: unknown): void {
    this.logger.warn(
      `AI ${operation} skipped, Redis unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
