import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../shared/auth/auth.guard';
import { CheckReadinessUseCase } from '../application/check-readiness.use-case';
import type { ReadinessReport } from '../domain/health-probe.port';
import { ApiZodResponse } from '../../../shared/validation/zod-dto';
import { LivenessResponse, ReadinessResponse } from './health.contracts';

/**
 * Liveness and readiness are deliberately DIFFERENT endpoints.
 *
 * Conflating them is a classic outage amplifier: if the liveness probe checks
 * the database, a brief database blip makes the orchestrator kill every healthy
 * container at once, turning a recoverable dependency wobble into a full
 * outage.
 *
 *   /health/live   process is up      -> touches no dependency, ever
 *   /health/ready  can serve traffic  -> checks dependencies, drains only
 */
@ApiTags('health')
// The load balancer has no credentials. Probes must stay reachable without
// authentication, and they expose no data beyond up/down.
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly checkReadiness: CheckReadinessUseCase) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 while the process is running. Touches no dependency, so a database outage never causes healthy containers to be killed.',
  })
  @ApiZodResponse(200, LivenessResponse, 'The process is alive.')
  live(): LivenessResponse {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports whether this instance can serve traffic. Always returns 200 with a status field — a probe that throws cannot be distinguished from a dead instance.',
  })
  @ApiZodResponse(200, ReadinessResponse, 'Dependency status for this instance.')
  ready(): Promise<ReadinessReport> {
    return this.checkReadiness.execute();
  }
}
