import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import {
  CreateChargeInput,
  CreateChargeResult,
  GatewayCharge,
  GatewayPaymentStatus,
  ParsedWebhookEvent,
  PaymentGateway,
  RefundInput,
  RefundResult,
} from './payment-gateway.interface';

/** The signed envelope the mock gateway "delivers" to our webhook endpoint. */
export interface MockWebhookEnvelope {
  id: string;
  type: string;
  data: {
    gatewayPaymentId?: string;
    gatewayRefundId?: string;
    status: GatewayPaymentStatus;
    amountMinor: number;
    feeMinor?: number;
    gatewayReference?: string;
    failureReason?: string;
  };
}

/**
 * A fully working sandbox gateway.
 *
 * It invents nothing about any real provider: it is its own toy gateway with its
 * own shapes, existing so the *platform's* payment flow — charge creation,
 * signed webhooks, signature verification, idempotent processing — is real and
 * testable end to end before Tap credentials exist. Swapping it for the Tap
 * adapter changes only what happens behind this interface.
 *
 * Its webhooks are signed with HMAC-SHA256 over the raw body, exactly so the
 * backend's verification path is genuinely exercised rather than stubbed to
 * "always valid".
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';

  constructor(private readonly webhookSecret: string) {}

  createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const gatewayPaymentId = `mock_ch_${randomUUID()}`;

    // A hosted-page redirect is simulated. In sandbox the payment is completed
    // by delivering a signed webhook (see buildWebhook / the simulate endpoint),
    // never by the client claiming success.
    return Promise.resolve({
      gatewayPaymentId,
      status: 'PENDING',
      clientAction: {
        type: 'redirect',
        url: `https://sandbox.mock-gateway.local/pay/${gatewayPaymentId}`,
      },
      gatewayReference: `mock_ref_${input.paymentId}`,
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    // Asynchronous by design: the refund is accepted as PENDING and finalised by
    // a signed webhook (buildRefundWebhook / simulate), never instantly here.
    return Promise.resolve({
      gatewayRefundId: `mock_rf_${randomUUID()}`,
      status: 'PENDING',
      gatewayReference: `mock_rfref_${input.refundId}`,
    });
  }

  retrieveCharge(gatewayPaymentId: string): Promise<GatewayCharge> {
    // The mock keeps no server-side charge store; a real gateway would return
    // the authoritative state here. In sandbox, state advances via webhooks, so
    // a pull-side check reports PENDING and changes nothing.
    return Promise.resolve({
      gatewayPaymentId,
      status: 'PENDING',
      amountMinor: 0,
      currency: 'SAR',
    });
  }

  /** HMAC-SHA256 of the raw body, hex-encoded, compared in constant time. */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature) {
      return false;
    }

    const expected = this.sign(rawBody);
    const provided = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    // Length-guard before timingSafeEqual, which throws on unequal lengths.
    if (provided.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(provided, expectedBuffer);
  }

  parseWebhookEvent(payload: unknown): ParsedWebhookEvent {
    const envelope = payload as Partial<MockWebhookEnvelope> | null;

    if (
      !envelope ||
      typeof envelope.id !== 'string' ||
      typeof envelope.type !== 'string' ||
      !envelope.data ||
      (typeof envelope.data.gatewayPaymentId !== 'string' &&
        typeof envelope.data.gatewayRefundId !== 'string')
    ) {
      throw new BadRequestException('Malformed webhook payload.');
    }

    return {
      gatewayEventId: envelope.id,
      eventType: envelope.type,
      gatewayPaymentId: envelope.data.gatewayPaymentId,
      gatewayRefundId: envelope.data.gatewayRefundId,
      status: envelope.data.status,
      amountMinor: envelope.data.amountMinor,
      feeMinor: envelope.data.feeMinor,
      gatewayReference: envelope.data.gatewayReference,
      failureReason: envelope.data.failureReason,
    };
  }

  // --- Sandbox helpers (dev/test only) --------------------------------------

  /**
   * Builds a signed webhook envelope, as though the gateway had sent it. This is
   * how a sandbox payment is completed — by delivering a genuine, correctly
   * signed event to the same endpoint a real gateway would call.
   */
  buildWebhook(
    data: MockWebhookEnvelope['data'],
    eventType?: string,
  ): {
    rawBody: string;
    signature: string;
  } {
    const envelope: MockWebhookEnvelope = {
      id: `mock_evt_${randomUUID()}`,
      type: eventType ?? (data.status === 'SUCCEEDED' ? 'charge.succeeded' : 'charge.failed'),
      data,
    };

    const rawBody = JSON.stringify(envelope);

    return { rawBody, signature: this.sign(rawBody) };
  }

  /** Builds a signed refund webhook, as the gateway would when a refund settles. */
  buildRefundWebhook(data: {
    gatewayRefundId: string;
    status: GatewayPaymentStatus;
    amountMinor: number;
    failureReason?: string;
  }): { rawBody: string; signature: string } {
    return this.buildWebhook(
      { ...data, gatewayReference: `mock_rfref_${data.gatewayRefundId}` },
      data.status === 'SUCCEEDED' ? 'refund.succeeded' : 'refund.failed',
    );
  }

  private sign(rawBody: Buffer | string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
}
