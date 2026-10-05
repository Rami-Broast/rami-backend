import { ServiceUnavailableException } from '@nestjs/common';

import {
  CreateChargeResult,
  GatewayCharge,
  ParsedWebhookEvent,
  PaymentGateway,
  RefundResult,
} from './payment-gateway.interface';

/**
 * The Tap Payments adapter — intentionally unimplemented.
 *
 * Tap is the confirmed gateway (spec §10), but **nothing about Tap's API may be
 * invented**: not an endpoint, not a field name, not the webhook signature
 * scheme. Implementing this adapter requires current official Tap documentation
 * and real merchant credentials, both of which are blocked business inputs.
 *
 * So this class exists to hold Tap's place behind the {@link PaymentGateway}
 * interface and to fail *loudly and specifically* if a deployment selects
 * `PAYMENT_GATEWAY=tap` before it is built — which is far safer than a silent
 * stub that pretends to take payments. When the documentation and credentials
 * arrive, only the bodies below change; nothing else in the platform does.
 */
export class TapPaymentGateway implements PaymentGateway {
  readonly name = 'tap';

  private notImplemented(): never {
    throw new ServiceUnavailableException(
      'The Tap payment gateway is not yet implemented. It requires current official ' +
        'Tap API documentation and merchant credentials (see Phase 11 blocked inputs). ' +
        'Use PAYMENT_GATEWAY=mock until then.',
    );
  }

  // Implemented with no parameters: TypeScript permits an implementation to omit
  // trailing interface parameters, and every one of these refuses before it
  // could use them.
  createCharge(): Promise<CreateChargeResult> {
    return this.notImplemented();
  }

  refund(): Promise<RefundResult> {
    return this.notImplemented();
  }

  retrieveCharge(): Promise<GatewayCharge> {
    return this.notImplemented();
  }

  verifyWebhookSignature(): boolean {
    return this.notImplemented();
  }

  parseWebhookEvent(): ParsedWebhookEvent {
    return this.notImplemented();
  }
}
