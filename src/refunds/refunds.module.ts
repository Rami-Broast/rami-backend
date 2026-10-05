import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentGatewayModule } from '../payments/gateway/payment-gateway.module';
import { RestoposZatcaModule } from '../zatca-invoicing/restopos-zatca.module';
import { CustomerRefundRequestsController } from './refund-requests.customer.controller';
import { RefundRequestsController } from './refund-requests.controller';
import { RefundRequestsService } from './refund-requests.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

/**
 * Refunds (Phase 12) and the customer refund/cancellation requests that lead to
 * them.
 *
 * `RefundsService` depends only on the shared payment gateway and the database.
 * Refund *completion* is driven by the payments module's webhook handler, which
 * calls {@link RefundsService.applyRefundEvent} — so this module has no
 * dependency back on payments, and the refund lifecycle stays split by
 * responsibility rather than by circular import.
 *
 * `RefundRequestsService` adds `OrdersModule` (to cancel an approved
 * cancellation through the order engine's one choke point), `NotificationsModule`
 * (to tell the customer what was decided) and `LoyaltyModule` (to reverse points
 * when a refund is recorded, exactly as the gateway path does from the webhook).
 * All three dependencies run one way — refunds → orders, never back — the same
 * shape as delivery.
 */
@Module({
  imports: [
    PaymentGatewayModule,
    OrdersModule,
    NotificationsModule,
    LoyaltyModule,
    RestoposZatcaModule,
    AuditModule,
  ],
  controllers: [RefundsController, RefundRequestsController, CustomerRefundRequestsController],
  providers: [RefundsService, RefundRequestsService],
  exports: [RefundsService, RefundRequestsService],
})
export class RefundsModule {}
