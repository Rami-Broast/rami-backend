import { Module } from '@nestjs/common';

import { CustomerNotificationsController } from './notifications.controller';
import { NotificationsQueryService } from './notifications-query.service';
import { NotificationsService } from './notifications.service';
import { PushModule } from './push/push.module';
import { SmsModule } from './sms/sms.module';

/**
 * Notifications (Phase 16).
 *
 * Depends only on the SMS and push provider ports (each with a mock adapter) and
 * the database — no domain module — so order, payment and refund modules can
 * import it and fire notifications without any circular dependency. Exports
 * `NotificationsService` for those triggers.
 */
@Module({
  imports: [SmsModule, PushModule],
  controllers: [CustomerNotificationsController],
  providers: [NotificationsService, NotificationsQueryService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
