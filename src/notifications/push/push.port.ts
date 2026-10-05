/**
 * Outbound push-notification port.
 *
 * Domain code depends on this interface, never on a vendor SDK (FCM, APNs, …),
 * so the provider can be swapped without touching notification logic — and the
 * notification flow is fully buildable and testable before any push contract
 * exists. No invented credentials, no guessed API shapes.
 */

export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushMessage {
  /** The customer this push is addressed to; the adapter resolves device tokens. */
  customerId: string;
  title: string;
  body: string;
  /** Structured payload for deep-linking, e.g. { orderId }. */
  data?: Record<string, string>;
}

export interface PushSendResult {
  providerMessageId?: string;
  provider: string;
  acceptedAt: Date;
}

export interface PushSender {
  send(message: PushMessage): Promise<PushSendResult>;
}
