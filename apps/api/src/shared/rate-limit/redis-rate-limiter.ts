import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { AppConfigService } from '../config/app-config.service';
import type { RateLimitDecision, RateLimitRule, RateLimiter } from './rate-limiter.port';

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * INCR + EXPIRE in a single pipeline, so two concurrent requests cannot both
 * read a stale count and both be allowed through. A sliding window would be
 * more precise at the window boundary; for "stop credential stuffing" a fixed
 * window is accurate enough and materially cheaper.
 *
 * FAIL-CLOSED on Redis errors for authentication rules. This is the important
 * decision: if the limiter cannot count, allowing unlimited login attempts
 * silently disables a security control at exactly the moment an attacker might
 * have caused the outage. Auth briefly returning 429 is the safer failure.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async consume(rule: RateLimitRule, key: string): Promise<RateLimitDecision> {
    const redisKey = this.keyFor(rule, key);

    try {
      const results = await this.redis.client
        .pipeline()
        .incr(redisKey)
        .expire(redisKey, rule.windowSeconds, 'NX')
        .ttl(redisKey)
        .exec();

      if (!results) throw new Error('Redis pipeline returned no result');

      const count = Number(results[0]?.[1] ?? 0);
      const ttl = Number(results[2]?.[1] ?? rule.windowSeconds);

      if (count > rule.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
        };
      }

      return {
        allowed: true,
        remaining: Math.max(0, rule.limit - count),
        retryAfterSeconds: 0,
      };
    } catch (error) {
      return this.onFailure(rule, error);
    }
  }

  async reset(rule: RateLimitRule, key: string): Promise<void> {
    try {
      await this.redis.client.del(this.keyFor(rule, key));
    } catch {
      // A counter that fails to clear only makes the limit stricter, which is
      // never a security problem. Not worth failing the request over.
    }
  }

  private keyFor(rule: RateLimitRule, key: string): string {
    return `eventq:ratelimit:${rule.name}:${key}`;
  }

  private onFailure(rule: RateLimitRule, error: unknown): RateLimitDecision {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Rate limiter unavailable for "${rule.name}": ${message}`);

    // In development a missing Redis should not block someone from signing in
    // to the app they are building. In production, refusing is correct.
    if (!this.config.isProduction) {
      this.logger.warn(`Allowing "${rule.name}" without rate limiting (non-production)`);
      return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    }

    return { allowed: false, remaining: 0, retryAfterSeconds: 30 };
  }
}
