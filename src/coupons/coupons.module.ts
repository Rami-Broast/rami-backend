import { Module } from '@nestjs/common';

import { CouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';

/**
 * Coupons (Phase 17).
 *
 * Depends only on the database. Exports `CouponsService` so the order engine can
 * evaluate a coupon at pricing time and record its usage inside the
 * order-creation transaction (atomic reuse prevention).
 */
@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
