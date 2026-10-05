import { Module } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { ZatcaProvider } from '../config/env.validation';
import { HttpRestoposZatcaGateway } from './http-restopos-zatca.gateway';
import { MockRestoposZatcaGateway } from './mock-restopos-zatca.gateway';
import { RESTOPOS_ZATCA, RestoposZatcaGateway } from './restopos-zatca.interface';
import { CustomerZatcaInvoiceController } from './zatca-invoice.customer.controller';
import { ZatcaInvoicesController } from './zatca-invoices.controller';
import { ZatcaInvoicingService } from './zatca-invoicing.service';
import { ZatcaWebhookController } from './zatca-webhook.controller';

/**
 * Provides the configured RestoPOS ZATCA adapter behind the {@link RESTOPOS_ZATCA}
 * token, chosen once at boot — the same shape as {@link PaymentGatewayModule}.
 *
 * The mock is the default and needs no infrastructure. The HTTP adapter is used
 * only when `ZATCA_PROVIDER=restopos`, and then a base URL is required; a
 * misconfiguration fails loudly at boot rather than silently issuing nothing.
 */
@Module({
  providers: [
    {
      provide: RESTOPOS_ZATCA,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): RestoposZatcaGateway => {
        const zatca = config.zatca;
        if (zatca.provider === ZatcaProvider.Restopos) {
          if (!zatca.baseUrl) {
            throw new Error('ZATCA_PROVIDER=restopos requires RESTOPOS_ZATCA_BASE_URL to be set.');
          }
          if (!zatca.publicApiUrl) {
            throw new Error(
              'ZATCA_PROVIDER=restopos requires PUBLIC_API_URL so RestoPOS can reach our webhook.',
            );
          }
          return new HttpRestoposZatcaGateway(
            zatca.baseUrl,
            zatca.publicApiUrl,
            `${zatca.publicApiUrl.replace(/\/+$/, '')}/webhooks/zatca`,
          );
        }

        return new MockRestoposZatcaGateway();
      },
    },
    ZatcaInvoicingService,
  ],
  controllers: [ZatcaWebhookController, ZatcaInvoicesController, CustomerZatcaInvoiceController],
  exports: [RESTOPOS_ZATCA, ZatcaInvoicingService],
})
export class RestoposZatcaModule {}
