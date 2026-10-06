import { Module } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { PushProvider } from '../../config/env.validation';
import { MockPushAdapter } from './mock-push.adapter';
import { PUSH_SENDER, PushSender } from './push.port';

/**
 * Selects the push adapter from configuration.
 *
 * Exhaustive on purpose: adding a provider to `PushProvider` without wiring an
 * adapter here becomes a compile error rather than a runtime surprise.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    MockPushAdapter,
    {
      provide: PUSH_SENDER,
      inject: [AppConfigService, MockPushAdapter],
      useFactory: (config: AppConfigService, mock: MockPushAdapter): PushSender => {
        switch (config.push.provider) {
          case PushProvider.Mock:
            return mock;
        }
      },
    },
  ],
  exports: [PUSH_SENDER],
})
export class PushModule {}
