import { Module } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { SmsProvider } from '../../config/env.validation';
import { MockSmsAdapter } from './mock-sms.adapter';
import { SMS_SENDER, SmsSender } from './sms.port';

/**
 * Selects the SMS adapter from configuration.
 *
 * The switch is exhaustive on purpose: adding a provider to the `SmsProvider`
 * enum without wiring an adapter here becomes a compile error rather than a
 * runtime surprise in production.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    MockSmsAdapter,
    {
      provide: SMS_SENDER,
      inject: [AppConfigService, MockSmsAdapter],
      useFactory: (config: AppConfigService, mock: MockSmsAdapter): SmsSender => {
        switch (config.sms.provider) {
          case SmsProvider.Mock:
            return mock;
        }
      },
    },
  ],
  exports: [SMS_SENDER],
})
export class SmsModule {}
