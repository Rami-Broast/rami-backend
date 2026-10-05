import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasources: { db: { url: config.database.url } },
      // Query logging includes bound parameters, which for this platform means
      // customer phone numbers and payment references — development only.
      log: config.app.isDevelopment
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Cheapest possible round-trip that proves the connection pool can reach
   * PostgreSQL. Used by the readiness probe.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.$queryRaw(Prisma.sql`SELECT 1`);
      return true;
    } catch (error) {
      // Connection strings appear in some driver errors — log the type only.
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.error(`Database readiness check failed: ${reason}`);
      return false;
    }
  }
}
