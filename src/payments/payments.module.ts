import { Module } from '@nestjs/common';

import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RefundsModule } from '../refunds/refunds.module';
import { RestoposZatcaModule } from '../zatca-invoicing/restopos-zatca.module';
import { PaymentGatewayModule } from './gateway/payment-gateway.module';
import { CustomerPaymentsController } from './payments.customer.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookController } from './payments.webhook.controller';

/**
 * Payments (Phase 11).
 *
 * The gateway adapter is chosen at boot from configuration and provided behind
 * the {@link PAYMENT_GATEWAY} token, so the rest of the module depends on the
 * interface, never on a concrete gateway. `mock` is the sandbox adapter; `tap`
 * is the real adapter, currently an explicit stub that refuses until official
 * documentation and credentials exist.
 *
 * Depends on `OrdersModule` so a verified payment advances the order through the
 * order engine's single transition choke point, and on `RefundsModule` so a
 * refund webhook is applied by the refunds service — webhook ingestion stays in
 * one place while refund logic stays in its own module.
 */
@Module({
  imports: [
    PaymentGatewayModule,
    OrdersModule,
    RefundsModule,
    NotificationsModule,
    LoyaltyModule,
    RestoposZatcaModule,
  ],
  controllers: [CustomerPaymentsController, PaymentsController, PaymentsWebhookController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
