import { Module } from '@nestjs/common';

import { ChargesModule } from '../charges/charges.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { CouponsModule } from '../coupons/coupons.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { BranchesModule } from '../branches/branches.module';
import { MenuModule } from '../menu/menu.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { OrderEditsService } from './order-edits.service';
import { CustomerOrdersController } from './orders.customer.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * The order engine (Phase 8).
 *
 * Depends on `MenuModule` for `CatalogService` (server-side cart pricing); the
 * VAT engine is provided globally by `VatModule`. `OrdersService` is exported so
 * later phases — payments, refunds, delivery — can drive order status
 * transitions through the same single choke point rather than mutating status
 * directly.
 */
@Module({
  imports: [
    // For the opening-hours rule at placement. Branches do not depend on
    // orders, so this stays one-directional.
    BranchesModule,
    MenuModule,
    NotificationsModule,
    CouponsModule,
    PromotionsModule,
    LoyaltyModule,
    RealtimeModule,
    ChargesModule,
    IdempotencyModule,
  ],
  controllers: [OrdersController, CustomerOrdersController],
  providers: [OrdersService, OrderEditsService],
  exports: [OrdersService, OrderEditsService],
})
export class OrdersModule {}
