import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaHealthIndicator } from './prisma.health';

// Orchestrator probes poll far more often than the public rate limit allows,
// and arrive without credentials — a load balancer has no bearer token.
@SkipThrottle()
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
  ) {}

  /**
   * Liveness: is the process up and able to serve? Deliberately checks no
   * dependencies — a failing database must not cause the orchestrator to
   * restart an otherwise healthy container.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe. Never touches dependencies.' })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: should this instance receive traffic? Fails while the database
   * is unreachable so the load balancer drains it instead of serving errors.
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe. Verifies the database round-trip.' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.prismaIndicator.isHealthy('database')]);
  }
}
