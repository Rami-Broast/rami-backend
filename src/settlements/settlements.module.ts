import { Module } from '@nestjs/common';

import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

/**
 * Settlements and reconciliation (Phase 18).
 *
 * Depends only on the database: it reconciles gateway payouts against the
 * payment and refund records other modules already wrote, and owns no state of
 * its own beyond the settlement and its transaction lines.
 */
@Module({
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
