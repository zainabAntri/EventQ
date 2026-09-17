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

  /**
   * The attendee surface, limited PER IP on top of the per-attendee allowance
   * the event itself configures.
   *
   * Two layers, because each defeats a different attack. The per-attendee limit
   * stops one person flooding; on its own it is trivially bypassed by minting a
   * fresh identity per request, since joining needs no account. The per-IP limit
   * stops that.
   *
   * The numbers are shaped by the real traffic pattern: a whole conference hall
   * usually shares one NAT address, so 800 people scanning the same QR code
   * within 90 seconds all arrive from one IP. A limit tight enough to stop a
   * single scripted attacker would lock out an entire venue, so these are set
   * to absorb a genuine room while still bounding automation — and the
   * per-attendee limit does the precise work.
   */
  attendeeJoin: { name: 'attendee:join', limit: 300, windowSeconds: 60 },
  questionSubmitPerIp: { name: 'question:submit:ip', limit: 120, windowSeconds: 60 },
  publicRead: { name: 'public:read', limit: 600, windowSeconds: 60 },

  /**
   * Voting, per ATTENDEE and per IP.
   *
   * The per-attendee rule is the precise one: thirty changes a minute is far
   * beyond a human deciding what they support, and well under what a script
   * flipping one vote on and off would attempt. The per-IP rule is deliberately
   * loose — a speaker saying "vote now" can make several hundred people on one
   * venue address act within the same few seconds, and a limit that refused
   * them would be worse than the abuse it prevents. Its job is only to bound a
   * script that mints fresh identities to vote repeatedly, and that script is
   * already capped by attendeeJoin above.
   */
  questionVote: { name: 'question:vote', limit: 30, windowSeconds: 60 },
  questionVotePerIp: { name: 'question:vote:ip', limit: 1200, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;
