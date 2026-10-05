/**
 * Outbound SMS port.
 *
 * Domain code depends on this interface, never on a vendor SDK, so the provider
 * can be swapped without touching authentication or notification logic. It also
 * means the OTP flow is fully buildable and testable before any SMS contract
 * exists — no invented credentials, no guessed API shapes.
 */

export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsMessage {
  /** Destination in E.164 format. */
  to: string;
  body: string;
  /**
   * True when the body contains a one-time passcode. Adapters must never log
   * the body of such a message.
   */
  sensitive?: boolean;
}

export interface SmsSendResult {
  /** Provider's own message identifier, where one is returned. */
  providerMessageId?: string;
  provider: string;
  acceptedAt: Date;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<SmsSendResult>;
}
