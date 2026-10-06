import request from 'supertest';

import { ErrorCode } from '../../src/common/constants/error-codes';
import { AuthTestContext, createAuthTestApp, uniquePhone } from './helpers/auth-app';

/**
 * Rate limiting, verified with the limiter genuinely enabled.
 *
 * Kept in its own file because it deliberately exhausts a per-IP budget, which
 * would otherwise make every later test in the same suite fail for reasons
 * unrelated to what they assert.
 */
describe('Auth rate limiting (e2e)', () => {
  let context: AuthTestContext;

  beforeAll(async () => {
    context = await createAuthTestApp({ throttle: true });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('stops runaway OTP requests, which cost real money per send', async () => {
    const http = () => request(context.app.getHttpServer());

    let sawRateLimit = false;
    let lastBody: Record<string, unknown> = {};

    // The endpoint allows 5 per minute per IP; the 6th must be refused.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await http()
        .post('/api/v1/auth/customer/otp/request')
        .send({ phone: uniquePhone() });

      if (response.status === 429) {
        sawRateLimit = true;
        lastBody = response.body as Record<string, unknown>;
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
    expect(lastBody.code).toBe(ErrorCode.RATE_LIMITED);
  });
});
