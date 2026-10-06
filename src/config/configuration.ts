import { Prisma } from '@prisma/client';

import {
  Environment,
  EnvironmentVariables,
  LogLevel,
  PaymentGatewayName,
  PushProvider,
  SmsProvider,
  ZatcaProvider,
} from './env.validation';

export interface AppConfig {
  env: Environment;
  isProduction: boolean;
  isDevelopment: boolean;
  port: number;
  bodyLimit: string;
  trustedProxyHops: number;
  corsAllowedOrigins: string[];
}

export interface LoggingConfig {
  level: LogLevel;
  pretty: boolean;
}

export interface DatabaseConfig {
  url: string;
}

export interface RateLimitConfig {
  ttlMs: number;
  max: number;
}

export interface DocsConfig {
  enabled: boolean;
}

export interface AuthConfig {
  accessTokenSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
}

export interface OtpConfig {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  maxRequestsPerHour: number;
  /**
   * Demo-only override — when set, every issued OTP equals this value. Never
   * populated when `NODE_ENV=production` (rejected at boot).
   */
  demoFixedCode?: string;
}

export interface SmsConfig {
  provider: SmsProvider;
}

export interface PushConfig {
  provider: PushProvider;
}

export interface PricingConfig {
  /** Standard VAT rate as an exact decimal, e.g. 0.15. */
  standardVatRate: Prisma.Decimal;
  /** True when catalog prices already contain VAT. */
  pricesIncludeVat: boolean;
  /** True when the delivery fee forms part of the taxable supply. */
  deliveryFeeTaxable: boolean;
}

export interface PaymentsConfig {
  /** The selected gateway adapter. */
  gateway: PaymentGatewayName;
  /** Sandbox rails, and the mock simulate endpoint, are enabled. */
  sandbox: boolean;
  /** HMAC secret the mock gateway signs and verifies webhooks with. */
  mockWebhookSecret: string;
  /**
   * Sandbox only: the mock gateway delivers its own signed success webhook so
   * an online order completes without a real bank. Ignored unless `sandbox` is
   * on and the gateway is the mock.
   */
  mockAutoSettle: boolean;
}

export interface ZatcaConfig {
  /** Whether ZATCA e-invoicing (via RestoPOS) is active at all. */
  enabled: boolean;
  /** The selected RestoPOS ZATCA adapter. */
  provider: ZatcaProvider;
  /** Base URL of the deployed RestoPOS ZATCA service; null on the mock. */
  baseUrl: string | null;
  /** This backend's own public URL, sent as each branch licence's backendUrl. */
  publicApiUrl: string | null;
  /** Secret used to verify inbound RestoPOS status webhooks. */
  webhookSecret: string;
  /** The chain's shared VAT number (one taxpayer, every branch); null if unset. */
  sellerVatNumber: string | null;
  /** Chain-owner account grouping all branch licences; null if unset. */
  chainOwner: string | null;
}

export interface LoyaltyConfig {
  /** Points earned per whole SAR of order total. Business-confirmed before launch. */
  pointsPerSar: number;
}

export interface DeliveryConfig {
  /**
   * The most deliveries one driver may hold at once. A safety ceiling on
   * stacked assignment, not an owner decision about batching — see
   * `DRIVER_MAX_ACTIVE_DELIVERIES`.
   */
  maxActiveDeliveriesPerDriver: number;
}

export interface RefundsConfig {
  /**
   * Minutes from **placement** in which a customer may ask to cancel.
   * Owner decision: 10. Null would mean no deadline.
   *
   * Runs from placement rather than from delivery because a cancellation is "I
   * have changed my mind" — the branch has bought ingredients and started
   * cooking, and the cost of a late change lands on them.
   */
  cancellationWindowMinutes: number | null;

  /**
   * Minutes from **delivery** in which a customer may ask for a refund.
   * Owner decision: 10. Null would mean no deadline.
   *
   * A refund is "something was wrong with what arrived", which cannot be known
   * until it arrives, so it runs on its own clock rather than the placement one.
   */
  requestWindowMinutes: number | null;
}
/**
 * The QZ Tray signing pair, or two nulls.
 *
 * Signed print requests are what stop a counter being asked "allow this site
 * to print?" — QZ prompts once per session for an unsigned page, and a
 * terminal that nobody reloads for a week still meets it every morning. The
 * key is here rather than in the POS because a private key in a browser bundle
 * is a published private key.
 */
export interface PrintingConfig {
  qzCertificate: string | null;
  qzPrivateKey: string | null;
}

export interface Configuration {
  app: AppConfig;
  logging: LoggingConfig;
  database: DatabaseConfig;
  rateLimit: RateLimitConfig;
  docs: DocsConfig;
  auth: AuthConfig;
  otp: OtpConfig;
  sms: SmsConfig;
  push: PushConfig;
  pricing: PricingConfig;
  payments: PaymentsConfig;
  zatca: ZatcaConfig;
  loyalty: LoyaltyConfig;
  delivery: DeliveryConfig;
  refunds: RefundsConfig;
  printing: PrintingConfig;
}

/**
 * Maps validated environment variables onto the typed configuration tree that
 * the rest of the application consumes. Modules should depend on this shape
 * rather than reading `process.env` directly.
 */
export function buildConfiguration(env: EnvironmentVariables): Configuration {
  const demoFixedCode = resolveDemoFixedCode(env);
  assertProductionPaymentRails(env);
  assertAutoSettleIsMockOnly(env);
  assertQzSigningPairIsComplete(env);
  assertProductionZatcaRails(env);

  return {
    app: {
      env: env.NODE_ENV,
      isProduction: env.NODE_ENV === Environment.Production,
      isDevelopment: env.NODE_ENV === Environment.Development,
      port: env.PORT,
      bodyLimit: env.BODY_LIMIT,
      trustedProxyHops: env.TRUSTED_PROXY_HOPS,
      corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },
    database: {
      url: env.DATABASE_URL,
    },
    rateLimit: {
      ttlMs: env.RATE_LIMIT_TTL_MS,
      max: env.RATE_LIMIT_MAX,
    },
    docs: {
      enabled: env.SWAGGER_ENABLED,
    },
    auth: {
      accessTokenSecret: env.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    },
    otp: {
      length: env.OTP_LENGTH,
      ttlSeconds: env.OTP_TTL_SECONDS,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      maxRequestsPerHour: env.OTP_MAX_REQUESTS_PER_HOUR,
      demoFixedCode,
    },
    sms: {
      provider: env.SMS_PROVIDER,
    },
    push: {
      provider: env.PUSH_PROVIDER,
    },
    pricing: {
      standardVatRate: new Prisma.Decimal(env.VAT_STANDARD_RATE),
      pricesIncludeVat: env.PRICES_INCLUDE_VAT,
      deliveryFeeTaxable: env.DELIVERY_FEE_TAXABLE,
    },
    payments: {
      gateway: env.PAYMENT_GATEWAY,
      sandbox: env.PAYMENT_SANDBOX,
      mockWebhookSecret: env.PAYMENT_MOCK_WEBHOOK_SECRET,
      mockAutoSettle: env.PAYMENT_MOCK_AUTO_SETTLE,
    },
    zatca: {
      enabled: env.ZATCA_INVOICING_ENABLED,
      provider: env.ZATCA_PROVIDER,
      baseUrl: env.RESTOPOS_ZATCA_BASE_URL ?? null,
      publicApiUrl: env.PUBLIC_API_URL ?? null,
      webhookSecret: env.RESTOPOS_ZATCA_WEBHOOK_SECRET,
      sellerVatNumber: env.ZATCA_SELLER_VAT_NUMBER ?? null,
      chainOwner: env.ZATCA_CHAIN_OWNER ?? null,
    },
    loyalty: {
      pointsPerSar: env.LOYALTY_POINTS_PER_SAR,
    },
    delivery: {
      maxActiveDeliveriesPerDriver: env.DRIVER_MAX_ACTIVE_DELIVERIES,
    },
    refunds: {
      cancellationWindowMinutes: env.REFUND_CANCELLATION_WINDOW_MINUTES ?? null,
      requestWindowMinutes: env.REFUND_REQUEST_WINDOW_MINUTES ?? null,
    },
    printing: {
      // Newlines survive an environment variable badly — Secret Manager and
      // most shells hand back `\n` as two characters — so a PEM is accepted
      // either way and normalised once, here, rather than at three call sites.
      qzCertificate: normalisePem(env.QZ_SIGNING_CERTIFICATE),
      qzPrivateKey: normalisePem(env.QZ_SIGNING_PRIVATE_KEY),
    },
  };
}

/**
 * Refuses half a QZ signing pair.
 *
 * A certificate with no key signs nothing, and a key with no certificate is a
 * secret sitting in an environment for no reason. Either way every print at
 * every counter is prompted — and the person who set the variable believes it
 * is configured. Two absent values are a legitimate state (unsigned printing,
 * one prompt per session); one is always a mistake.
 */
function assertQzSigningPairIsComplete(env: EnvironmentVariables): void {
  const hasCertificate = Boolean(env.QZ_SIGNING_CERTIFICATE?.trim());
  const hasKey = Boolean(env.QZ_SIGNING_PRIVATE_KEY?.trim());

  if (hasCertificate !== hasKey) {
    throw new Error(
      'QZ_SIGNING_CERTIFICATE and QZ_SIGNING_PRIVATE_KEY must be set together — one without the other signs nothing, and every print at a branch is prompted.',
    );
  }
}

/** A PEM as it survives an env var: real newlines, or the two-character kind. */
function normalisePem(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\\n/g, '\n') : null;
}

/**
 * Resolves the demo-only OTP override, or refuses one that would compromise a
 * real deployment. Kept next to `buildConfiguration` because the length check
 * needs `OTP_LENGTH`, which a validator on `EnvironmentVariables` cannot see.
 */
/**
 * Refuses the sandbox payment rails in production.
 *
 * Both of these default to the safe-for-development value, which is the unsafe
 * one to deploy: `PAYMENT_GATEWAY` defaults to `mock` and `PAYMENT_SANDBOX`
 * used to default to `true`. In that state
 * `POST /webhooks/payments/:gateway/simulate` is public, unauthenticated, and
 * marks any order PAID — so forgetting to configure payments produced a
 * deployment where anyone who could reach the API could pay for nothing.
 *
 * Refusing at boot is the same discipline `resolveDemoFixedCode` applies to the
 * pinned demo OTP: a demo-only affordance must fail the deploy rather than fail
 * open. `PAYMENT_SANDBOX` now also defaults to `false`, so the default is the
 * safe one and enabling the sandbox is a deliberate act.
 */
/**
 * Refuses a production boot that would issue **fake** tax invoices to a real
 * taxpayer. ZATCA invoicing is delegated to RestoPOS; the `mock` adapter issues
 * self-consistent but non-ZATCA documents for the demo. With invoicing on in
 * production, the adapter must be `restopos` and must know where the service is.
 *
 * The same shape as `assertProductionPaymentRails`: the forgot-to-configure
 * state must never be the one that puts an invalid tax document in front of a
 * customer. Only fires at `NODE_ENV=production`, so the mock demo is unaffected.
 */
function assertProductionZatcaRails(env: EnvironmentVariables): void {
  if (env.NODE_ENV !== Environment.Production || !env.ZATCA_INVOICING_ENABLED) {
    return;
  }

  if (env.ZATCA_PROVIDER === ZatcaProvider.Mock) {
    throw new Error(
      'ZATCA_PROVIDER must not be `mock` when NODE_ENV=production and ZATCA invoicing is enabled — the mock issues non-ZATCA documents. Set ZATCA_PROVIDER=restopos.',
    );
  }

  if (!env.RESTOPOS_ZATCA_BASE_URL) {
    throw new Error(
      'RESTOPOS_ZATCA_BASE_URL is required when ZATCA invoicing is enabled in production.',
    );
  }

  if (!env.PUBLIC_API_URL) {
    throw new Error(
      'PUBLIC_API_URL is required when ZATCA invoicing is enabled in production, so RestoPOS status webhooks can reach this backend.',
    );
  }

  if (!env.ZATCA_SELLER_VAT_NUMBER) {
    throw new Error(
      'ZATCA_SELLER_VAT_NUMBER (the chain VAT number) is required when ZATCA invoicing is enabled in production.',
    );
  }
}

function assertProductionPaymentRails(env: EnvironmentVariables): void {
  if (env.NODE_ENV !== Environment.Production) {
    return;
  }

  if (env.PAYMENT_SANDBOX) {
    throw new Error(
      'PAYMENT_SANDBOX must be false when NODE_ENV=production — it enables the gateway simulation endpoint, which marks orders paid without money moving.',
    );
  }

  if (env.PAYMENT_GATEWAY === PaymentGatewayName.Mock) {
    throw new Error(
      'PAYMENT_GATEWAY must not be `mock` when NODE_ENV=production — the mock gateway takes no real payment.',
    );
  }

  if (env.PAYMENT_MOCK_AUTO_SETTLE) {
    throw new Error(
      'PAYMENT_MOCK_AUTO_SETTLE must be false when NODE_ENV=production — it marks orders PAID by delivering the mock gateway’s own webhook, with no money moving.',
    );
  }

  // Deliberately NOT guarded here: SMS_PROVIDER. A production deployment on the
  // mock SMS adapter delivers no sign-in codes and is genuinely unusable — but
  // `SmsProvider` currently has exactly one value, `mock`, so no configuration
  // could satisfy such a guard. It would fail every production boot for a
  // reason the operator cannot act on, which is a worse failure than the one it
  // prevents. `PAYMENT_GATEWAY` differs: `tap` is a real, selectable value whose
  // adapter refuses loudly, so that guard is satisfiable today.
  //
  // The moment a real SMS provider is added to the enum, add the same assertion
  // here — it belongs with these, not in a runbook.
}

/**
 * Refuses the mock gateway’s self-settling affordance alongside a real gateway.
 *
 * `PAYMENT_MOCK_AUTO_SETTLE` exists because the mock gateway has no hosted page
 * and no bank, so nothing would ever deliver its success webhook. It is
 * meaningless with any other adapter, and the combination is a configuration
 * mistake rather than a choice — most likely a demo variable carried into an
 * environment that has since been pointed at a real gateway. That is exactly
 * the shape of mistake worth failing the boot over, and it is caught here
 * regardless of `NODE_ENV`, because a staging environment taking real payments
 * is no better than a production one taking none.
 */
function assertAutoSettleIsMockOnly(env: EnvironmentVariables): void {
  if (env.PAYMENT_MOCK_AUTO_SETTLE && env.PAYMENT_GATEWAY !== PaymentGatewayName.Mock) {
    throw new Error(
      `PAYMENT_MOCK_AUTO_SETTLE is only meaningful with PAYMENT_GATEWAY=mock, but the gateway is \`${env.PAYMENT_GATEWAY}\`. Set it to false.`,
    );
  }
}

function resolveDemoFixedCode(env: EnvironmentVariables): string | undefined {
  const raw = env.OTP_DEMO_FIXED_CODE;
  if (raw === undefined || raw === '') {
    return undefined;
  }

  if (env.NODE_ENV === Environment.Production) {
    throw new Error(
      'OTP_DEMO_FIXED_CODE must not be set when NODE_ENV=production — a pinned OTP is a demo-only affordance.',
    );
  }

  if (raw.length !== env.OTP_LENGTH) {
    throw new Error(
      `OTP_DEMO_FIXED_CODE length (${raw.length}) does not match OTP_LENGTH (${env.OTP_LENGTH}).`,
    );
  }

  return raw;
}
