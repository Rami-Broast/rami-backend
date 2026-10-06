import { Module } from '@nestjs/common';

import { CustomerLoyaltyController, LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

/**
 * Loyalty (Phase 17).
 *
 * Depends only on the database and configuration. Exports `LoyaltyService` so
 * the order and payment modules can earn points on delivery and reverse them on
 * cancellation/refund — called post-commit and best-effort, so loyalty can never
 * break the operation that triggered it.
 */
@Module({
  controllers: [CustomerLoyaltyController, LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
