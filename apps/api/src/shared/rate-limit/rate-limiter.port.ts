export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts left in the current window. */
  remaining: number;
  /** Seconds until the window frees up. Only meaningful when denied. */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Stable identifier, forms part of the storage key. */
  readonly name: string;
  /** Attempts permitted per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Port: rate limiting.
 *
 * An interface rather than a direct Redis call so use-cases can be tested
 * without a container, and so the backing store can change without touching
 * anything that enforces a limit.
 */
export interface RateLimiter {
  /** Consumes one attempt against `key` and reports whether it is allowed. */
  consume(rule: RateLimitRule, key: string): Promise<RateLimitDecision>;

  /** Clears the counter — used after a successful login, so one bad password
   *  followed by the right one does not count toward a lockout. */
  reset(rule: RateLimitRule, key: string): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * The rules in force.
 *
 * Registration and login are limited per IP; login is ALSO limited per account
 * (see account-lockout.ts), because an attacker with many IPs still has to
 * attack one account at a time.
 */
export const RATE_LIMIT_RULES = {
  register: { name: 'auth:register', limit: 5, windowSeconds: 60 * 60 },
  login: { name: 'auth:login', limit: 10, windowSeconds: 15 * 60 },
  refresh: { name: 'auth:refresh', limit: 60, windowSeconds: 60 * 60 },
  eventWrite: { name: 'event:write', limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;
