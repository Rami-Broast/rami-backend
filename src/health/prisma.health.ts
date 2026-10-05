import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const session = this.healthIndicatorService.check(key);
    const reachable = await this.prisma.isReachable();

    // The failure reason is deliberately generic: readiness output is often
    // exposed to load balancers and uptime monitors outside the trust boundary.
    return reachable ? session.up() : session.down('Database unreachable');
  }
}
