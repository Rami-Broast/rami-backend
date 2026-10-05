import { Module } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { PaymentGatewayName } from '../../config/env.validation';
import { MockPaymentGateway } from './mock-payment.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { TapPaymentGateway } from './tap-payment.gateway';

/**
 * Provides the configured payment gateway adapter behind the
 * {@link PAYMENT_GATEWAY} token.
 *
 * Its own module so that both the payments module and the refunds module depend
 * on the *interface* through a single shared provider, rather than each
 * constructing an adapter. The adapter is chosen once, at boot, from
 * configuration.
 */
@Module({
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): PaymentGateway => {
        if (config.payments.gateway === PaymentGatewayName.Tap) {
          return new TapPaymentGateway();
        }

        return new MockPaymentGateway(config.payments.mockWebhookSecret);
      },
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentGatewayModule {}
