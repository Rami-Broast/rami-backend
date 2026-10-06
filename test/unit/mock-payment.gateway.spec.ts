import { BadRequestException } from '@nestjs/common';

import { MockPaymentGateway } from '../../src/payments/gateway/mock-payment.gateway';

describe('MockPaymentGateway', () => {
  const secret = 'a-sufficiently-long-mock-secret';
  const gateway = new MockPaymentGateway(secret);

  describe('createCharge', () => {
    it('returns a gateway id and a client action, never marking anything paid', async () => {
      const result = await gateway.createCharge({
        paymentId: 'pay-1',
        orderId: 'order-1',
        orderNumber: 'ORD-1',
        amountMinor: 11_500,
        currency: 'SAR',
        idempotencyKey: 'key-1',
        customer: { id: 'cust-1' },
      });

      expect(result.gatewayPaymentId).toMatch(/^mock_ch_/);
      expect(result.status).toBe('PENDING');
      expect(result.clientAction.type).toBe('redirect');
      expect(result.clientAction.url).toContain(result.gatewayPaymentId);
    });
  });

  describe('webhook signing and verification', () => {
    it('verifies a signature it produced over the same body', () => {
      const { rawBody, signature } = gateway.buildWebhook({
        gatewayPaymentId: 'mock_ch_1',
        status: 'SUCCEEDED',
        amountMinor: 11_500,
      });

      expect(gateway.verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it('rejects a tampered body', () => {
      const { rawBody, signature } = gateway.buildWebhook({
        gatewayPaymentId: 'mock_ch_1',
        status: 'SUCCEEDED',
        amountMinor: 11_500,
      });

      const tampered = rawBody.replace('11500', '1');
      expect(gateway.verifyWebhookSignature(tampered, signature)).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const other = new MockPaymentGateway('a-different-mock-secret-value');
      const { rawBody, signature } = other.buildWebhook({
        gatewayPaymentId: 'mock_ch_1',
        status: 'SUCCEEDED',
        amountMinor: 11_500,
      });

      expect(gateway.verifyWebhookSignature(rawBody, signature)).toBe(false);
    });

    it('rejects a missing signature', () => {
      const { rawBody } = gateway.buildWebhook({
        gatewayPaymentId: 'mock_ch_1',
        status: 'SUCCEEDED',
        amountMinor: 11_500,
      });

      expect(gateway.verifyWebhookSignature(rawBody, undefined)).toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('parses a well-formed envelope into neutral terms', () => {
      const { rawBody } = gateway.buildWebhook({
        gatewayPaymentId: 'mock_ch_9',
        status: 'SUCCEEDED',
        amountMinor: 500,
        feeMinor: 12,
      });

      const event = gateway.parseWebhookEvent(JSON.parse(rawBody));
      expect(event.gatewayPaymentId).toBe('mock_ch_9');
      expect(event.status).toBe('SUCCEEDED');
      expect(event.amountMinor).toBe(500);
      expect(event.feeMinor).toBe(12);
      expect(event.gatewayEventId).toMatch(/^mock_evt_/);
    });

    it('rejects a malformed payload', () => {
      expect(() => gateway.parseWebhookEvent({ nope: true })).toThrow(BadRequestException);
    });
  });
});
