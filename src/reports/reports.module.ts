import { Module } from '@nestjs/common';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reports (Phase 18).
 *
 * Read-only over snapshotted order and payment data — depends only on the
 * database and holds no state. Branch isolation is applied per query, the same
 * as every other module.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
