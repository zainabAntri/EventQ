import { Inject, Injectable } from '@nestjs/common';
import {
  HEALTH_PROBES,
  type HealthProbe,
  type ProbeState,
  type ReadinessReport,
} from '../domain/health-probe.port';

/**
 * Decides whether this instance can serve traffic.
 *
 * Depends only on the HealthProbe port, so it has no idea Prisma exists. That
 * is what makes it testable with two fake probes and no container.
 */
@Injectable()
export class CheckReadinessUseCase {
  constructor(@Inject(HEALTH_PROBES) private readonly probes: readonly HealthProbe[]) {}

  async execute(): Promise<ReadinessReport> {
    // Concurrently, not sequentially: readiness latency should be the slowest
    // probe, not the sum of all of them.
    const results = await Promise.all(
      this.probes.map(async (probe): Promise<[string, ProbeState]> => {
        try {
          return [probe.name, (await probe.check()) ? 'up' : 'down'];
        } catch {
          // A probe that throws is a probe that is down. It must never turn the
          // readiness endpoint itself into a 500 — the orchestrator needs an
          // answer, not an exception.
          return [probe.name, 'down'];
        }
      }),
    );

    const checks = Object.fromEntries(results);
    const allUp = results.every(([, state]) => state === 'up');

    return { status: allUp ? 'ready' : 'degraded', checks };
  }
}
