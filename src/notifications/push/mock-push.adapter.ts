import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PushMessage, PushSender, PushSendResult } from './push.port';

/**
 * Development and test push adapter.
 *
 * No push provider has been contracted yet, so rather than invent an API shape
 * or a credential, notifications are built against the real port and this
 * adapter stands in. Swapping in a live provider (FCM/APNs) means adding one
 * class — nothing in the notification flow changes.
 *
 * It records that a send happened, by customer id and title, never any personal
 * message content beyond what is needed to correlate a support report.
 */
@Injectable()
export class MockPushAdapter implements PushSender {
  private readonly logger = new Logger(MockPushAdapter.name);

  send(message: PushMessage): Promise<PushSendResult> {
    this.logger.log(
      { customerId: message.customerId, title: message.title },
      'Mock push accepted (not delivered)',
    );

    return Promise.resolve({
      provider: 'mock',
      providerMessageId: `mock-push-${randomUUID()}`,
      acceptedAt: new Date(),
    });
  }
}
