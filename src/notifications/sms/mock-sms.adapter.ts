import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { SmsMessage, SmsSender, SmsSendResult } from './sms.port';

/**
 * Development and test SMS adapter.
 *
 * No SMS provider has been contracted yet, so rather than invent an API shape
 * or a credential, the OTP flow is built against the real port and this adapter
 * stands in. Swapping in a live provider means adding one class — nothing in
 * the auth flow changes.
 *
 * It records that a send happened and never what was sent: an OTP written to a
 * log is an OTP leaked to everyone with log access.
 */
@Injectable()
export class MockSmsAdapter implements SmsSender {
  private readonly logger = new Logger(MockSmsAdapter.name);

  send(message: SmsMessage): Promise<SmsSendResult> {
    this.logger.log(
      {
        to: maskPhone(message.to),
        bodyLength: message.body.length,
        sensitive: message.sensitive === true,
      },
      'Mock SMS accepted (not delivered)',
    );

    return Promise.resolve({
      provider: 'mock',
      providerMessageId: `mock-${randomUUID()}`,
      acceptedAt: new Date(),
    });
  }
}

/**
 * Leaves only the last two digits, so a log line is enough to correlate a
 * support report without recording the customer's number.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 2) {
    return '*'.repeat(phone.length);
  }

  return `${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`;
}
