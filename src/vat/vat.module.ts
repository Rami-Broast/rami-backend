import { Global, Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { VatService } from './vat.service';

/**
 * Global because pricing is a single authority: orders, invoices, refunds and
 * reporting must all reach the same engine rather than each importing a copy of
 * the rules.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [VatService],
  exports: [VatService],
})
export class VatModule {}
