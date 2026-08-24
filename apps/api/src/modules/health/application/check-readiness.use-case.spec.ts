import { describe, expect, it } from 'vitest';
import { CheckReadinessUseCase } from './check-readiness.use-case';
import type { HealthProbe } from '../domain/health-probe.port';

/**
 * The payoff of the port/adapter split: this exercises the real readiness
 * logic with no database, no container and no framework bootstrap. It runs in
 * single-digit milliseconds, so it stays in the fast feedback loop.
 */
const probe = (name: string, result: boolean | (() => Promise<never>)): HealthProbe => ({
  name,
  check: typeof result === 'function' ? result : async () => result,
});

describe('CheckReadinessUseCase', () => {
  it('reports ready when every probe is up', async () => {
    const useCase = new CheckReadinessUseCase([probe('database', true), probe('redis', true)]);

    await expect(useCase.execute()).resolves.toEqual({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports degraded when any probe is down', async () => {
    const useCase = new CheckReadinessUseCase([probe('database', true), probe('redis', false)]);

    await expect(useCase.execute()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'up', redis: 'down' },
    });
  });

  it('treats a throwing probe as down rather than failing the endpoint', async () => {
    // The important guarantee: an orchestrator polling /health/ready must get an
    // answer. If this endpoint 500s, the platform cannot distinguish a sick
    // dependency from a broken health check and may cycle healthy containers.
    const exploding = probe('database', async () => {
      throw new Error('connection reset');
    });

    await expect(
      new CheckReadinessUseCase([exploding, probe('redis', true)]).execute(),
    ).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'down', redis: 'up' },
    });
  });

  it('is ready with no probes registered', async () => {
    await expect(new CheckReadinessUseCase([]).execute()).resolves.toEqual({
      status: 'ready',
      checks: {},
    });
  });
});
