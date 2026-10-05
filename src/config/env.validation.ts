import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

/** Registered SMS providers. Extend as real integrations are added. */
export enum SmsProvider {
  Mock = 'mock',
}

/** Registered push-notification providers. Extend as real integrations are added. */
export enum PushProvider {
  Mock = 'mock',
}

/**
 * Registered payment gateways.
 *
 * `mock` is a fully working sandbox adapter used for development and tests — it
 * signs and verifies its own webhooks so the verification path is real. `tap`
 * selects the real Tap adapter, which is an explicit stub until official Tap API
 * documentation and merchant credentials exist; selecting it without that
 * implementation fails loudly rather than inventing gateway behaviour.
 */
export enum PaymentGatewayName {
  Mock = 'mock',
  Tap = 'tap',
}

export enum ZatcaProvider {
  Mock = 'mock',
  Restopos = 'restopos',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
}

/**
 * Coerces the common string spellings of booleans that arrive from process.env
 * and container orchestrators.
 */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalised = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
  if (['false', '0', 'no', 'off'].includes(normalised)) return false;
  return value;
};

/**
 * Every environment variable the backend reads at boot.
 *
 * Variables belonging to later phases (Tap, ZATCA, SMS, maps, push, storage)
 * are deliberately NOT validated here — they are documented in `.env.example`
 * and will be added to this class by the phase that actually consumes them, so
 * that a missing future credential can never block the foundation from booting.
 */
export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /** PostgreSQL connection string. Supplied by secret management, never committed. */
  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  /** Pretty-prints logs for local development. Must stay false in deployed environments. */
  @Transform(toBoolean)
  @IsBoolean()
  LOG_PRETTY: boolean = false;

  /**
   * Comma-separated list of allowed browser origins. Empty disables CORS
   * entirely, which is the correct default for a mobile-app-only deployment.
   */
  @IsOptional()
  @IsString()
  CORS_ALLOWED_ORIGINS?: string;

  /** Rate limit window in milliseconds. */
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RATE_LIMIT_TTL_MS: number = 60_000;

  /** Maximum requests allowed per window, per client. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX: number = 120;

  /**
   * Serves the OpenAPI explorer. Defaults to false so that production must opt
   * in explicitly rather than opt out.
   */
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED: boolean = false;

  /**
   * Number of reverse proxies in front of the app. Required for correct client
   * IP resolution, which rate limiting and audit logging depend on.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUSTED_PROXY_HOPS: number = 0;

  /** Request body size limit. Guards against oversized-payload denial of service. */
  @IsString()
  BODY_LIMIT: string = '1mb';

  // --- Phase 4: authentication ---------------------------------------------

  /**
   * Signing key for access tokens. Required with no default: a predictable or
   * absent signing key would let anyone mint a valid token for any account, so
   * the app must refuse to start rather than fall back to something guessable.
   */
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  /** Access token lifetime. Short by design — revocation happens at refresh. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(10)
  OTP_LENGTH: number = 6;

  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(900)
  OTP_TTL_SECONDS: number = 300;

  /** Wrong guesses allowed before the challenge is burned. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  OTP_MAX_ATTEMPTS: number = 5;

  /** Minimum gap between OTP requests for one phone number. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  OTP_RESEND_COOLDOWN_SECONDS: number = 60;

  /** Ceiling on OTP requests per phone per hour, to cap SMS cost and abuse. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_MAX_REQUESTS_PER_HOUR: number = 5;

  /**
   * Demo-only override that pins every issued OTP to a known value, so a live
   * demo audience without a phone can still complete the login flow. All-digit
   * string whose length must match `OTP_LENGTH`; the length coupling is
   * enforced in `buildConfiguration`, not here, because a validator on this
   * class cannot see other properties.
   *
   * The override is refused at boot when `NODE_ENV=production` — a fixed
   * credential must never be reachable in a real deployment. An empty string
   * is treated as unset, so a container template that exports `FOO=` for an
   * unpopulated slot does not crash boot.
   */
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' && value.length === 0 ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'OTP_DEMO_FIXED_CODE must be all digits' })
  OTP_DEMO_FIXED_CODE?: string;

  /**
   * The QZ Tray signing pair, PEM.
   *
   * Signing is what removes the "untrusted website" dialog from every print at
   * a counter. The **private key never leaves this server** — the browser asks
   * this API to sign each request — so it arrives through secret management
   * like any other credential, and is never committed.
   *
   * Both optional and useless apart: with neither, printing still works and the
   * counter is prompted once per session; with only one, nothing is signed. The
   * boot guard below refuses that half-configured state rather than letting a
   * branch discover it at 8pm.
   */
  @IsOptional()
  @IsString()
  QZ_SIGNING_CERTIFICATE?: string;

  @IsOptional()
  @IsString()
  QZ_SIGNING_PRIVATE_KEY?: string;

  /**
   * SMS provider for OTP delivery. `mock` logs delivery metadata only and is
   * the default until real credentials are supplied — never invent them.
   */
  @IsEnum(SmsProvider)
  SMS_PROVIDER: SmsProvider = SmsProvider.Mock;

  /**
   * Push-notification provider. `mock` logs delivery metadata only and is the
   * default until a real provider (e.g. FCM/APNs) is contracted — never invent
   * credentials or an API shape.
   */
  @IsEnum(PushProvider)
  PUSH_PROVIDER: PushProvider = PushProvider.Mock;

  // --- Phase 7: pricing and VAT --------------------------------------------

  /**
   * Standard VAT rate as a decimal fraction. 0.15 is the current Saudi standard
   * rate and is confirmed for this platform.
   *
   * Configurable rather than hard-coded because a statutory rate can change,
   * and when it does, historical orders must keep the rate they were charged at
   * — which is why every order and invoice line snapshots the rate applied
   * rather than referring back to this value.
   */
  @IsString()
  @Matches(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/, {
    message: 'VAT_STANDARD_RATE must be a decimal fraction between 0 and 1, e.g. 0.15',
  })
  VAT_STANDARD_RATE: string = '0.15';

  /**
   * Whether catalog prices already include VAT.
   *
   * True for this platform: Saudi consumer-facing prices are displayed
   * inclusive of VAT, so a menu price of 32.50 already contains its tax and the
   * engine backs the tax out rather than adding to it.
   */
  @Transform(toBoolean)
  @IsBoolean()
  PRICES_INCLUDE_VAT: boolean = true;

  /**
   * Whether the delivery fee is taxable.
   *
   * Treated as part of the taxable supply by default, which is the conventional
   * handling. Flagged in ARCHITECTURE.md as requiring accountant confirmation
   * before production.
   */
  @Transform(toBoolean)
  @IsBoolean()
  DELIVERY_FEE_TAXABLE: boolean = true;

  // --- Phase 17: loyalty ----------------------------------------------------

  /**
   * Loyalty points earned per whole SAR of an order's total (i.e. per 100
   * halalas). Configurable because the earn rate is a business decision, not a
   * technical one — the default of 1 point per SAR is a placeholder and must be
   * confirmed with the owner before launch. Set to 0 to disable earning.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  LOYALTY_POINTS_PER_SAR: number = 1;

  // --- Phase 14: delivery dispatch ------------------------------------------

  /**
   * The most deliveries one driver may be carrying at once.
   *
   * A driver used to be assignable only while free, so a counter could not hand
   * a second drop to the person already riding that way. Stacking is allowed
   * now, and this is the **ceiling on it, not a policy about it**: how many
   * drops one driver should carry depends on the vehicle, the bag and the
   * distances, which is the owner's call. The default is a safety limit so a
   * mis-click cannot put a dozen orders on one motorcycle — confirm the real
   * number with the owner before launch, exactly like the VAT rate and the
   * loyalty earn rate.
   *
   * `1` restores the old one-job-at-a-time behaviour.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  DRIVER_MAX_ACTIVE_DELIVERIES: number = 3;

  // --- Refund requests ------------------------------------------------------

  /**
   * Minutes after **delivery** in which a customer may still ask for a refund.
   * **Owner decision: 10.**
   *
   * Minutes rather than hours because that is the unit the answer came in, and
   * a window this short cannot be expressed in hours at all. Clearing it means
   * no deadline.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(525_600)
  REFUND_REQUEST_WINDOW_MINUTES?: number = 10;

  /**
   * Minutes from placement in which a customer may ask to cancel an order the
   * kitchen has already started. **Owner decision: 10.**
   *
   * A number rather than a hard-coded constant for the same reason as the VAT
   * rate: it is the owner's policy, and the day they want 15 minutes it should
   * not be a deploy of changed logic. Clearing it means no deadline.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  REFUND_CANCELLATION_WINDOW_MINUTES?: number = 10;

  // --- Phase 11: payments ---------------------------------------------------

  /**
   * Which payment gateway adapter to use. `mock` by default — the real Tap
   * adapter is a stub until official docs and merchant credentials exist, so a
   * deployment must opt into `tap` explicitly and only once it is implemented.
   */
  @IsEnum(PaymentGatewayName)
  PAYMENT_GATEWAY: PaymentGatewayName = PaymentGatewayName.Mock;

  /**
   * Sandbox mode. True keeps everything on test rails and enables the mock
   * gateway's simulate endpoint — a public, unauthenticated route that marks
   * an order PAID.
   *
   * Defaults to **false**, and is refused outright when `NODE_ENV=production`
   * (see `assertProductionPaymentRails`). It defaulted to `true`, which meant
   * the state you got by forgetting to configure payments was the one where
   * anybody could pay for nothing. Sandbox and production gateway credentials
   * are strictly separated (spec §10).
   */
  @Transform(toBoolean)
  @IsBoolean()
  PAYMENT_SANDBOX: boolean = false;

  /**
   * HMAC secret the mock gateway signs its webhooks with, and the backend
   * verifies them against. A development value only — the mock never touches
   * real money. Real Tap secrets arrive through secret management, never here,
   * and are validated by the Tap adapter when it is implemented.
   */
  @IsString()
  @MinLength(16, { message: 'PAYMENT_MOCK_WEBHOOK_SECRET must be at least 16 characters' })
  PAYMENT_MOCK_WEBHOOK_SECRET: string = 'mock-dev-webhook-secret-change-me';

  /**
   * Sandbox only: the mock gateway settles a charge by itself.
   *
   * Without it, an online order sits in PENDING_PAYMENT for ever on the demo.
   * The mock gateway has no hosted page and no bank behind it, so nothing ever
   * delivers the webhook that a real gateway would, and the order never reaches
   * the branch — it is invisible on the POS and untrackable for the customer.
   * With it, the **server** delivers its own correctly signed success webhook
   * through the ordinary ingestion path.
   *
   * This does not weaken "client success is never proof of payment": the client
   * still proves nothing, the signature is still verified, and the order still
   * advances only from a verified webhook. It is the sandbox standing in for
   * the bank, which is what a sandbox is.
   *
   * Meaningless unless `PAYMENT_SANDBOX` is on and the gateway is the mock —
   * both of which are refused outright in production.
   *
   * Defaults to **false**, like `PAYMENT_SANDBOX` itself: the state you get by
   * forgetting to configure payments must never be the one where orders mark
   * themselves paid. The demo deployment turns it on explicitly.
   */
  @Transform(toBoolean)
  @IsBoolean()
  PAYMENT_MOCK_AUTO_SETTLE: boolean = false;

  /**
   * Whether ZATCA e-invoicing (delegated to RestoPOS) is active.
   *
   * Off by default: with it off nothing calls RestoPOS, no invoice records are
   * written, and the platform behaves as it did before the integration. This is
   * the safe state a deployment gets by not configuring anything. Turn it on to
   * issue a real tax invoice per order via RestoPOS.
   */
  @Transform(toBoolean)
  @IsBoolean()
  ZATCA_INVOICING_ENABLED: boolean = false;

  /**
   * Which RestoPOS ZATCA adapter to use. `mock` is a fully working in-memory
   * stand-in for the demo (no service deployed, no taxpayer onboarded);
   * `restopos` talks to a deployed RestoPOS ZATCA service and requires
   * `RESTOPOS_ZATCA_BASE_URL`.
   */
  @IsEnum(ZatcaProvider)
  ZATCA_PROVIDER: ZatcaProvider = ZatcaProvider.Mock;

  /**
   * Base URL of the deployed RestoPOS ZATCA service, e.g.
   * `https://restopos-zatca-xxxx.run.app`. Required only when
   * `ZATCA_PROVIDER=restopos`; the mock ignores it.
   */
  @IsOptional()
  @IsString()
  RESTOPOS_ZATCA_BASE_URL?: string;

  /**
   * This backend's own public URL, sent to RestoPOS as each branch licence's
   * `backendUrl`/`webhookUrl` so status callbacks can reach us. Required only
   * when `ZATCA_PROVIDER=restopos`.
   */
  @IsOptional()
  @IsString()
  PUBLIC_API_URL?: string;

  /**
   * Shared secret used to verify inbound RestoPOS status webhooks. A development
   * value by default — a real secret arrives through secret management. Never a
   * real gateway credential; RestoPOS status callbacks carry no money.
   */
  @IsString()
  @MinLength(16, { message: 'RESTOPOS_ZATCA_WEBHOOK_SECRET must be at least 16 characters' })
  RESTOPOS_ZATCA_WEBHOOK_SECRET: string = 'mock-dev-zatca-webhook-secret-change-me';

  /**
   * The chain's shared VAT number (one taxpayer, every branch). Sent on each
   * branch's ZATCA registration alongside that branch's own CR. Optional — the
   * mock ignores it; the real provider needs it before a branch can register.
   */
  @IsOptional()
  @IsString()
  ZATCA_SELLER_VAT_NUMBER?: string;

  /**
   * Chain-owner account name sent to RestoPOS as each branch licence's
   * `parentAccount`, so all branches group under one owner (one login/bill) in
   * RestoPOS-Admin. Optional; a blank value leaves each licence standalone.
   */
  @IsOptional()
  @IsString()
  ZATCA_CHAIN_OWNER?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join(', ');
        return `  - ${error.property}: ${constraints || 'invalid value'}`;
      })
      .join('\n');

    // Values are deliberately omitted from this message: DATABASE_URL and
    // future gateway credentials must never reach logs or crash output.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return validated;
}
