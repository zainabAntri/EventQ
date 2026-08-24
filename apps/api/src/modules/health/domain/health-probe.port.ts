/**
 * Port: a dependency that can report whether it is usable.
 *
 * Framework-free by construction — no Nest, no Prisma, no imports at all. The
 * domain states WHAT it needs ("something that can tell me if it is healthy");
 * infrastructure decides HOW (a Prisma query, a Redis PING, an S3 head request).
 *
 * Adding Redis or S3 to the readiness check later means writing one adapter and
 * registering it. No use-case and no controller changes.
 */
export interface HealthProbe {
  /** Stable identifier, surfaced as the key in the readiness response. */
  readonly name: string;

  /**
   * Must never throw and never hang indefinitely — a readiness endpoint that
   * blocks is worse than one that reports a failure, because the load balancer
   * cannot tell the difference between "slow" and "dead".
   */
  check(): Promise<boolean>;
}

/**
 * DI token.
 *
 * A symbol rather than a class reference, because the domain must not import
 * the concrete implementation it is trying to stay independent of.
 */
export const HEALTH_PROBES = Symbol('HEALTH_PROBES');

export type ProbeState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'degraded';
  checks: Record<string, ProbeState>;
}
