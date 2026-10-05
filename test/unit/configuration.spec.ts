import { buildConfiguration } from '../../src/config/configuration';
import { Environment, validateEnv } from '../../src/config/env.validation';

const baseEnv = (overrides: Record<string, string> = {}) =>
  validateEnv({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a-test-signing-key-of-sufficient-length',
    ...overrides,
  });

describe('buildConfiguration', () => {
  it('marks production correctly', () => {
    // A production config has to name real payment rails now — the mock
    // gateway and the sandbox are refused there. See the block below.
    const config = buildConfiguration(
      baseEnv({
        NODE_ENV: Environment.Production,
        PAYMENT_GATEWAY: 'tap',
        PAYMENT_SANDBOX: 'false',
      }),
    );

    expect(config.app.isProduction).toBe(true);
    expect(config.app.isDevelopment).toBe(false);
  });

  describe('CORS origins', () => {
    it('parses a comma-separated list and trims whitespace', () => {
      const config = buildConfiguration(
        baseEnv({ CORS_ALLOWED_ORIGINS: 'https://admin.example.com, https://ops.example.com' }),
      );

      expect(config.app.corsAllowedOrigins).toEqual([
        'https://admin.example.com',
        'https://ops.example.com',
      ]);
    });

    it('yields an empty allow-list when unset, so no browser origin is permitted', () => {
      expect(buildConfiguration(baseEnv()).app.corsAllowedOrigins).toEqual([]);
    });

    it('discards empty entries from a trailing or doubled comma', () => {
      const config = buildConfiguration(
        baseEnv({ CORS_ALLOWED_ORIGINS: 'https://a.example.com,,  ,' }),
      );

      expect(config.app.corsAllowedOrigins).toEqual(['https://a.example.com']);
    });
  });

  it('carries the database URL through untouched', () => {
    const url = 'postgresql://user:pass@localhost:5432/db';
    expect(buildConfiguration(baseEnv()).database.url).toBe(url);
  });

  describe('payment rails in production', () => {
    // These two default to the value that is right for development and wrong
    // to deploy, so the failure mode is forgetting rather than choosing. In
    // sandbox mode the gateway's simulate endpoint is public and marks any
    // order PAID — an unconfigured production deploy would let anyone pay for
    // nothing.
    it('defaults the sandbox off, so the default is the safe one', () => {
      expect(buildConfiguration(baseEnv()).payments.sandbox).toBe(false);
    });

    it('refuses the sandbox in production', () => {
      expect(() =>
        buildConfiguration(baseEnv({ NODE_ENV: Environment.Production, PAYMENT_SANDBOX: 'true' })),
      ).toThrow(/PAYMENT_SANDBOX must be false when NODE_ENV=production/);
    });

    it('refuses the mock gateway in production', () => {
      expect(() =>
        buildConfiguration(baseEnv({ NODE_ENV: Environment.Production, PAYMENT_GATEWAY: 'mock' })),
      ).toThrow(/PAYMENT_GATEWAY must not be `mock` when NODE_ENV=production/);
    });

    /**
     * The demo affordance that made an order PAID with no money.
     *
     * The production deploy path must not be able to carry it, and the guard is
     * deliberately separate from the `PAYMENT_GATEWAY=mock` one even though a
     * production deploy would trip that first: the two are set independently,
     * and an error naming the actual offending variable is what an operator can
     * act on.
     */
    it('refuses the mock auto-settle in production', () => {
      expect(() =>
        buildConfiguration(
          baseEnv({
            NODE_ENV: Environment.Production,
            PAYMENT_GATEWAY: 'tap',
            PAYMENT_MOCK_AUTO_SETTLE: 'true',
          }),
        ),
      ).toThrow(/PAYMENT_MOCK_AUTO_SETTLE must be false when NODE_ENV=production/);
    });

    /**
     * Auto-settle only means anything for the mock gateway, which has no hosted
     * page and no bank. Paired with a real gateway it is a leftover demo
     * variable, and that is worth refusing in *any* environment — a staging
     * deployment quietly self-settling real charges is no better than a
     * production one.
     */
    it('refuses auto-settle alongside a real gateway, in any environment', () => {
      expect(() =>
        buildConfiguration(
          baseEnv({
            NODE_ENV: Environment.Staging,
            PAYMENT_GATEWAY: 'tap',
            PAYMENT_MOCK_AUTO_SETTLE: 'true',
          }),
        ),
      ).toThrow(/PAYMENT_MOCK_AUTO_SETTLE is only meaningful with PAYMENT_GATEWAY=mock/);
    });

    it('allows auto-settle with the mock gateway outside production', () => {
      // This is the demo deploy's configuration and it must keep working.
      const config = buildConfiguration(
        baseEnv({
          NODE_ENV: Environment.Staging,
          PAYMENT_GATEWAY: 'mock',
          PAYMENT_MOCK_AUTO_SETTLE: 'true',
        }),
      );
      expect(config.payments.mockAutoSettle).toBe(true);
    });

    it('allows the sandbox outside production', () => {
      expect(
        buildConfiguration(baseEnv({ NODE_ENV: Environment.Development, PAYMENT_SANDBOX: 'true' }))
          .payments.sandbox,
      ).toBe(true);
    });

    it('accepts a real gateway with the sandbox off in production', () => {
      const config = buildConfiguration(
        baseEnv({
          NODE_ENV: Environment.Production,
          PAYMENT_GATEWAY: 'tap',
          PAYMENT_SANDBOX: 'false',
        }),
      );

      expect(config.payments.sandbox).toBe(false);
      expect(config.payments.gateway).toBe('tap');
    });
  });

  describe('demo OTP override', () => {
    it('is undefined when the env var is not set', () => {
      expect(buildConfiguration(baseEnv()).otp.demoFixedCode).toBeUndefined();
    });

    it('carries the pinned value through when its length matches OTP_LENGTH', () => {
      const config = buildConfiguration(baseEnv({ OTP_DEMO_FIXED_CODE: '123456' }));

      expect(config.otp.demoFixedCode).toBe('123456');
    });

    it('refuses to boot when the pinned value does not match OTP_LENGTH', () => {
      expect(() => buildConfiguration(baseEnv({ OTP_DEMO_FIXED_CODE: '1234' }))).toThrow(
        /OTP_DEMO_FIXED_CODE length \(4\) does not match OTP_LENGTH \(6\)/,
      );
    });

    it('refuses to boot in production so a pinned OTP cannot reach a real deployment', () => {
      expect(() =>
        buildConfiguration(
          baseEnv({ NODE_ENV: Environment.Production, OTP_DEMO_FIXED_CODE: '123456' }),
        ),
      ).toThrow(/OTP_DEMO_FIXED_CODE must not be set when NODE_ENV=production/);
    });

    it('treats an empty string the same as unset', () => {
      expect(
        buildConfiguration(baseEnv({ OTP_DEMO_FIXED_CODE: '' })).otp.demoFixedCode,
      ).toBeUndefined();
    });
  });
  describe('the QZ Tray signing pair', () => {
    const CERT = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const KEY = '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----';

    it('is absent by default, which is unsigned printing and a prompt per session', () => {
      const config = buildConfiguration(baseEnv());

      expect(config.printing.qzCertificate).toBeNull();
      expect(config.printing.qzPrivateKey).toBeNull();
    });

    it('accepts a PEM whose newlines survived an environment variable as two characters', () => {
      // Secret Manager and most shells hand a PEM back with literal \n. Left
      // as-is, every signature is refused and printing looks broken with the
      // configuration apparently correct.
      const config = buildConfiguration(
        baseEnv({
          QZ_SIGNING_CERTIFICATE: CERT.replace(/\n/g, '\\n'),
          QZ_SIGNING_PRIVATE_KEY: KEY,
        }),
      );

      expect(config.printing.qzCertificate).toBe(CERT);
    });

    it('refuses to boot on half a pair', () => {
      // A certificate with no key signs nothing and a key with no certificate
      // is a secret sitting in an environment for no reason — and either way
      // the person who set it believes printing is configured.
      expect(() => buildConfiguration(baseEnv({ QZ_SIGNING_CERTIFICATE: CERT }))).toThrow(
        /must be set together/,
      );
      expect(() => buildConfiguration(baseEnv({ QZ_SIGNING_PRIVATE_KEY: KEY }))).toThrow(
        /must be set together/,
      );
    });

    it('boots with both, and with neither', () => {
      expect(() =>
        buildConfiguration(baseEnv({ QZ_SIGNING_CERTIFICATE: CERT, QZ_SIGNING_PRIVATE_KEY: KEY })),
      ).not.toThrow();
      expect(() => buildConfiguration(baseEnv())).not.toThrow();
    });
  });

  describe('ZATCA invoicing rails in production', () => {
    // A production deploy that reaches these guards must first satisfy the
    // payment rails, so every case names real payment rails too.
    const prod = (overrides: Record<string, string> = {}) =>
      baseEnv({
        NODE_ENV: Environment.Production,
        PAYMENT_GATEWAY: 'tap',
        PAYMENT_SANDBOX: 'false',
        ...overrides,
      });

    it('does nothing when invoicing is disabled (the default)', () => {
      expect(() => buildConfiguration(prod())).not.toThrow();
    });

    it('refuses the mock adapter in production with invoicing on', () => {
      expect(() =>
        buildConfiguration(prod({ ZATCA_INVOICING_ENABLED: 'true', ZATCA_PROVIDER: 'mock' })),
      ).toThrow(/ZATCA_PROVIDER must not be `mock` when NODE_ENV=production/);
    });

    it('requires the base URL, public URL and VAT number in production', () => {
      expect(() =>
        buildConfiguration(prod({ ZATCA_INVOICING_ENABLED: 'true', ZATCA_PROVIDER: 'restopos' })),
      ).toThrow(/RESTOPOS_ZATCA_BASE_URL is required/);

      expect(() =>
        buildConfiguration(
          prod({
            ZATCA_INVOICING_ENABLED: 'true',
            ZATCA_PROVIDER: 'restopos',
            RESTOPOS_ZATCA_BASE_URL: 'https://zatca.example.com',
          }),
        ),
      ).toThrow(/PUBLIC_API_URL is required/);

      expect(() =>
        buildConfiguration(
          prod({
            ZATCA_INVOICING_ENABLED: 'true',
            ZATCA_PROVIDER: 'restopos',
            RESTOPOS_ZATCA_BASE_URL: 'https://zatca.example.com',
            PUBLIC_API_URL: 'https://api.example.com',
          }),
        ),
      ).toThrow(/ZATCA_SELLER_VAT_NUMBER .* is required/);
    });

    it('boots when fully configured for production', () => {
      expect(() =>
        buildConfiguration(
          prod({
            ZATCA_INVOICING_ENABLED: 'true',
            ZATCA_PROVIDER: 'restopos',
            RESTOPOS_ZATCA_BASE_URL: 'https://zatca.example.com',
            PUBLIC_API_URL: 'https://api.example.com',
            ZATCA_SELLER_VAT_NUMBER: '311111111100003',
          }),
        ),
      ).not.toThrow();
    });
  });
});
