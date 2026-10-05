import { Module } from '@nestjs/common';

import { DriversModule } from '../drivers/drivers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RestoposZatcaModule } from '../zatca-invoicing/restopos-zatca.module';
import { CashCollectionService } from './cash-collection.service';
import { CustomerDeliveryController } from './delivery-customer.controller';
import { DeliveryDriverController } from './delivery-driver.controller';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

/**
 * Delivery (Phase 14).
 *
 * Depends on `OrdersModule` for `OrdersService.applyTransition` — the same
 * single choke point every other status-changing module drives order status
 * through — and on `DriversModule` for driver ownership resolution. The
 * dependency runs one way (delivery → orders), matching how refunds depends on
 * payments' interface rather than the reverse: `Delivery` rows themselves are
 * opened and cancelled by `OrdersService` directly (see its `applyTransition`),
 * so orders never has to depend back on this module.
 */
@Module({
  imports: [
    OrdersModule,
    DriversModule,
    NotificationsModule,
    LoyaltyModule,
    RealtimeModule,
    RestoposZatcaModule,
  ],
  controllers: [DeliveryController, DeliveryDriverController, CustomerDeliveryController],
  providers: [DeliveryService, CashCollectionService],
  exports: [DeliveryService, CashCollectionService],
})
export class DeliveryModule {}
