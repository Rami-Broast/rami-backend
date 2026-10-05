import { ServiceUnavailableException } from '@nestjs/common';

import { TapPaymentGateway } from '../../src/payments/gateway/tap-payment.gateway';

/**
 * The Tap adapter is deliberately unimplemented — it must never silently
 * pretend to take a payment. Every method fails loudly and specifically until
 * official Tap documentation and credentials exist.
 */
describe('TapPaymentGateway (stub)', () => {
  const tap = new TapPaymentGateway();

  it('is named tap', () => {
    expect(tap.name).toBe('tap');
  });

  it('refuses to create a charge', () => {
    // Throws immediately; a caller awaiting it receives the rejection.
    expect(() => tap.createCharge()).toThrow(ServiceUnavailableException);
  });

  it('refuses to verify a signature rather than returning a permissive default', () => {
    expect(() => tap.verifyWebhookSignature()).toThrow(ServiceUnavailableException);
  });
});
