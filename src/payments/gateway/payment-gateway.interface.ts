import { PaymentMethod } from '@prisma/client';

/**
 * The payment gateway port.
 *
 * Everything the platform does with a gateway goes through this interface, so a
 * gateway is *one adapter behind an interface* rather than an assumption baked
 * into the order and payment code. The mock adapter implements it for sandbox
 * and tests; the Tap adapter implements it for real money once official
 * documentation and merchant credentials exist.
 *
 * The types here are deliberately **gateway-neutral**. They do not borrow Tap's
 * field names or event shapes, because those must come from official Tap
 * documentation — not be guessed. Each adapter translates between this neutral
 * shape and its gateway's real API at its own boundary.
 */

/** Neutral outcome vocabulary every adapter maps its gateway's states onto. */
export type GatewayPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** What the backend hands a gateway to start a charge. */
export interface CreateChargeInput {
  /** Our Payment id — the stable reference this charge belongs to. */
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: 'SAR';
  method?: PaymentMethod;
  /**
   * Idempotency key for this attempt. A replayed create-charge request carrying
   * the same key must never produce a second charge — the adapter forwards it to
   * gateways that support idempotent creation, and the backend also enforces it
   * with a unique constraint on the attempt.
   */
  idempotencyKey: string;
  customer: { id: string; phone?: string; email?: string };
  /** Where the gateway should return the customer after a hosted-page flow. */
  returnUrl?: string;
}

/** An action the client must complete to pay (e.g. a hosted-page redirect). */
export interface GatewayClientAction {
  type: 'redirect' | 'none';
  url?: string;
}

/** The result of starting a charge. Never proof of payment on its own. */
export interface CreateChargeResult {
  gatewayPaymentId: string;
  status: GatewayPaymentStatus;
  clientAction: GatewayClientAction;
  /** Opaque gateway reference, if the gateway issues one at creation. */
  gatewayReference?: string;
}

/** What the backend hands a gateway to refund a captured charge. */
export interface RefundInput {
  /** Our Refund id — the stable reference this gateway refund belongs to. */
  refundId: string;
  gatewayPaymentId: string;
  amountMinor: number;
  currency: 'SAR';
  reason: string;
  /** Idempotency key; a replayed refund request must never refund twice. */
  idempotencyKey: string;
}

/**
 * The result of requesting a refund. Completion is **asynchronous** — a gateway
 * rarely refunds instantly, so a PENDING/PROCESSING result is normal and the
 * final state arrives by webhook or a later lookup. Never assume SUCCEEDED here.
 */
export interface RefundResult {
  gatewayRefundId: string;
  status: GatewayPaymentStatus;
  gatewayReference?: string;
}

/** The gateway's own view of a charge, from a server-initiated lookup. */
export interface GatewayCharge {
  gatewayPaymentId: string;
  status: GatewayPaymentStatus;
  amountMinor: number;
  currency: string;
  gatewayReference?: string;
  feeMinor?: number;
}

/**
 * A webhook event after signature verification and parsing into neutral terms.
 * Acted upon only once the signature has verified — a parsed event from an
 * unverified body is never trusted.
 */
export interface ParsedWebhookEvent {
  /** Unique per gateway; the idempotency key for webhook processing. */
  gatewayEventId: string;
  eventType: string;
  gatewayPaymentId?: string;
  /** Present when the event concerns a refund rather than the original charge. */
  gatewayRefundId?: string;
  status?: GatewayPaymentStatus;
  amountMinor?: number;
  feeMinor?: number;
  gatewayReference?: string;
  failureReason?: string;
}

export interface PaymentGateway {
  /** Stable adapter name, persisted on every gateway-facing record. */
  readonly name: string;

  /** Starts a charge on the gateway. Returns what the client must do next. */
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;

  /**
   * Requests a refund of a captured charge. Completion is asynchronous — the
   * result is typically PENDING/PROCESSING and finalised by webhook.
   */
  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Server-initiated lookup of a charge's current state. This — not a client
   * reporting success — is the authoritative pull-side check that can advance
   * payment state when a webhook is missed.
   */
  retrieveCharge(gatewayPaymentId: string): Promise<GatewayCharge>;

  /**
   * Verifies a webhook's signature against its raw body. Must be called on the
   * exact bytes received, before the body is parsed or trusted.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean;

  /** Parses an already-verified webhook body into the neutral event shape. */
  parseWebhookEvent(payload: unknown): ParsedWebhookEvent;
}

/** DI token for the configured gateway adapter. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
