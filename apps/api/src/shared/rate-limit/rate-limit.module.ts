import { Global, Module } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { RedisRateLimiter } from './redis-rate-limiter';
import { RATE_LIMITER } from './rate-limiter.port';

@Global()
@Module({
  providers: [
    RedisService,
    RedisRateLimiter,
    { provide: RATE_LIMITER, useExisting: RedisRateLimiter },
  ],
  exports: [RedisService, RATE_LIMITER],
})
export class RateLimitModule {}
