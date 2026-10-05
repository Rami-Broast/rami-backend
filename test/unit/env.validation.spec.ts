import { Environment, LogLevel, validateEnv } from '../../src/config/env.validation';

const MINIMUM_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a-test-signing-key-of-sufficient-length',
};

describe('validateEnv', () => {
  it('applies safe defaults when only the required variables are supplied', () => {
    const env = validateEnv({ ...MINIMUM_ENV });

    expect(env.NODE_ENV).toBe(Environment.Development);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe(LogLevel.Info);
  });

  it('defaults the OpenAPI explorer to disabled so production must opt in', () => {
    expect(validateEnv({ ...MINIMUM_ENV }).SWAGGER_ENABLED).toBe(false);
  });

  it('defaults pretty logging off so deployed environments emit parseable JSON', () => {
    expect(validateEnv({ ...MINIMUM_ENV }).LOG_PRETTY).toBe(false);
  });

  it('rejects a missing DATABASE_URL rather than starting without a database', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  describe('access token secret', () => {
    it('refuses to start without one, rather than defaulting to something guessable', () => {
      const withoutSecret = { DATABASE_URL: MINIMUM_ENV.DATABASE_URL };

      expect(() => validateEnv(withoutSecret)).toThrow(/JWT_ACCESS_SECRET/);
    });

    it('rejects a secret short enough to be brute-forced', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
        /JWT_ACCESS_SECRET/,
      );
    });

    it('never echoes the secret in the failure message', () => {
      const secret = 'short';

      let message = '';
      try {
        validateEnv({ ...MINIMUM_ENV, JWT_ACCESS_SECRET: secret, PORT: '0' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).not.toContain(secret);
    });
  });

  describe('OTP settings', () => {
    it('defaults to a six digit code with a five minute life', () => {
      const env = validateEnv({ ...MINIMUM_ENV });

      expect(env.OTP_LENGTH).toBe(6);
      expect(env.OTP_TTL_SECONDS).toBe(300);
      expect(env.OTP_MAX_ATTEMPTS).toBe(5);
    });

    it('rejects a code short enough to guess', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, OTP_LENGTH: '3' })).toThrow(/OTP_LENGTH/);
    });

    it('rejects an unlimited attempt budget', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, OTP_MAX_ATTEMPTS: '999' })).toThrow(
        /OTP_MAX_ATTEMPTS/,
      );
    });

    it('rejects an access token lifetime beyond an hour', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, JWT_ACCESS_TTL_SECONDS: '86400' })).toThrow(
        /JWT_ACCESS_TTL_SECONDS/,
      );
    });
  });

  describe('demo OTP override', () => {
    it('is unset by default so codes stay random', () => {
      expect(validateEnv({ ...MINIMUM_ENV }).OTP_DEMO_FIXED_CODE).toBeUndefined();
    });

    it('accepts an all-digit value', () => {
      const env = validateEnv({ ...MINIMUM_ENV, OTP_DEMO_FIXED_CODE: '123456' });

      expect(env.OTP_DEMO_FIXED_CODE).toBe('123456');
    });

    it('rejects a non-numeric value rather than pinning something unusable', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, OTP_DEMO_FIXED_CODE: '12ab56' })).toThrow(
        /OTP_DEMO_FIXED_CODE/,
      );
    });
  });

  it('rejects an unknown SMS provider rather than silently sending nothing', () => {
    expect(() => validateEnv({ ...MINIMUM_ENV, SMS_PROVIDER: 'twilio' })).toThrow(/SMS_PROVIDER/);
  });

  it('never echoes configuration values in the failure message', () => {
    const secret = 'postgresql://admin:sup3r-s3cret@db.internal:5432/prod';

    let message = '';
    try {
      validateEnv({ DATABASE_URL: secret, PORT: 'not-a-port' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('PORT');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('sup3r-s3cret');
    expect(message).not.toContain('not-a-port');
  });

  describe('boolean coercion', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
    ])('reads SWAGGER_ENABLED=%s as %s', (raw, expected) => {
      expect(validateEnv({ ...MINIMUM_ENV, SWAGGER_ENABLED: raw }).SWAGGER_ENABLED).toBe(expected);
    });

    it('rejects a value that is neither truthy nor falsy rather than guessing', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, SWAGGER_ENABLED: 'maybe' })).toThrow(
        /SWAGGER_ENABLED/,
      );
    });
  });

  describe('numeric bounds', () => {
    it('accepts a port inside the valid range', () => {
      expect(validateEnv({ ...MINIMUM_ENV, PORT: '8080' }).PORT).toBe(8080);
    });

    it.each(['0', '65536', '-1', 'abc'])('rejects PORT=%s', (port) => {
      expect(() => validateEnv({ ...MINIMUM_ENV, PORT: port })).toThrow(/PORT/);
    });

    it('rejects a rate limit window below one second', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, RATE_LIMIT_TTL_MS: '500' })).toThrow(
        /RATE_LIMIT_TTL_MS/,
      );
    });

    it('rejects a rate limit of zero, which would deny all traffic', () => {
      expect(() => validateEnv({ ...MINIMUM_ENV, RATE_LIMIT_MAX: '0' })).toThrow(/RATE_LIMIT_MAX/);
    });
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...MINIMUM_ENV, NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('reports every invalid variable at once rather than failing on the first', () => {
    let message = '';
    try {
      validateEnv({ ...MINIMUM_ENV, PORT: '0', NODE_ENV: 'prod', LOG_LEVEL: 'verbose' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('PORT');
    expect(message).toContain('NODE_ENV');
    expect(message).toContain('LOG_LEVEL');
  });
});
