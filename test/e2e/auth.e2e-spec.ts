import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { ErrorCode } from '../../src/common/constants/error-codes';
import {
  AuthTestContext,
  CapturingSmsAdapter,
  createAuthTestApp,
  uniquePhone,
} from './helpers/auth-app';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  tokenType: string;
}

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

interface ActorBody {
  kind: string;
  phone?: string;
  permissions: string[];
  branchScope: { kind: string; branchIds?: string[] };
}

describe('Authentication (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let sms: CapturingSmsAdapter;
  let http: () => ReturnType<typeof request>;

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    sms = context.sms;
    http = () => request(context.app.getHttpServer());
  });

  afterAll(async () => {
    await context?.close();
  });

  beforeEach(() => {
    sms.clear();
  });

  /** Completes a full customer login and returns the tokens. */
  async function loginCustomer(phone: string): Promise<Tokens> {
    await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);

    const code = sms.lastCodeFor(phone);

    const response = await http()
      .post('/api/v1/auth/customer/otp/verify')
      .send({ phone, code })
      .expect(200);

    return response.body as Tokens;
  }

  describe('customer OTP login', () => {
    it('issues tokens for a valid code and creates the account', async () => {
      const phone = uniquePhone();

      const tokens = await loginCustomer(phone);

      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.tokenType).toBe('Bearer');

      const customer = await prisma.customer.findUnique({ where: { phone } });
      expect(customer).not.toBeNull();
      expect(customer?.phoneVerifiedAt).not.toBeNull();
    });

    it('never returns the code in the request response', async () => {
      const phone = uniquePhone();

      const response = await http()
        .post('/api/v1/auth/customer/otp/request')
        .send({ phone })
        .expect(200);

      const code = sms.lastCodeFor(phone);
      expect(JSON.stringify(response.body)).not.toContain(code);
    });

    it('never stores the code in plaintext', async () => {
      const phone = uniquePhone();
      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);

      const code = sms.lastCodeFor(phone);
      const challenge = await prisma.otpChallenge.findFirstOrThrow({
        where: { phone },
        orderBy: { createdAt: 'desc' },
      });

      expect(challenge.codeHash).not.toContain(code);
      expect(challenge.codeHash.startsWith('$argon2id$')).toBe(true);
    });

    it('rejects a wrong code', async () => {
      const phone = uniquePhone();
      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);

      const wrong = sms.lastCodeFor(phone) === '111111' ? '222222' : '111111';

      await http()
        .post('/api/v1/auth/customer/otp/verify')
        .send({ phone, code: wrong })
        .expect(401);
    });

    it('refuses to reuse a code that already logged someone in', async () => {
      const phone = uniquePhone();
      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);
      const code = sms.lastCodeFor(phone);

      await http().post('/api/v1/auth/customer/otp/verify').send({ phone, code }).expect(200);

      // Single use: a replayed code is worthless even though it was valid.
      await http().post('/api/v1/auth/customer/otp/verify').send({ phone, code }).expect(401);
    });

    it('invalidates an earlier code when a new one is requested', async () => {
      const phone = uniquePhone();

      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);
      const firstCode = sms.lastCodeFor(phone);

      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);

      // Otherwise every resend would widen the set of codes that work.
      await http()
        .post('/api/v1/auth/customer/otp/verify')
        .send({ phone, code: firstCode })
        .expect(401);
    });

    it('burns the challenge after the attempt budget is spent', async () => {
      const phone = uniquePhone();
      await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);
      const realCode = sms.lastCodeFor(phone);
      const wrong = realCode === '000000' ? '999999' : '000000';

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await http()
          .post('/api/v1/auth/customer/otp/verify')
          .send({ phone, code: wrong })
          .expect(401);
      }

      // Even the correct code no longer works: the challenge is spent, so an
      // attacker must go back through the request rate limit.
      await http()
        .post('/api/v1/auth/customer/otp/verify')
        .send({ phone, code: realCode })
        .expect(401);
    });

    it('gives the same answer for a wrong code and an unknown number', async () => {
      const known = uniquePhone();
      await http().post('/api/v1/auth/customer/otp/request').send({ phone: known }).expect(200);

      const knownResponse = await http()
        .post('/api/v1/auth/customer/otp/verify')
        .send({ phone: known, code: '000000' })
        .expect(401);

      const unknownResponse = await http()
        .post('/api/v1/auth/customer/otp/verify')
        .send({ phone: uniquePhone(), code: '000000' })
        .expect(401);

      // Differing responses would turn this endpoint into a customer-directory
      // oracle.
      const known401 = knownResponse.body as ErrorBody;
      const unknown401 = unknownResponse.body as ErrorBody;

      expect(known401.message).toBe(unknown401.message);
      expect(known401.code).toBe(unknown401.code);
    });

    it('rejects a malformed phone number', async () => {
      const response = await http()
        .post('/api/v1/auth/customer/otp/request')
        .send({ phone: '0500000000' })
        .expect(400);

      expect((response.body as ErrorBody).code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects an undeclared field rather than ignoring it', async () => {
      await http()
        .post('/api/v1/auth/customer/otp/request')
        .send({ phone: uniquePhone(), isAdmin: true })
        .expect(400);
    });
  });

  describe('staff login', () => {
    const password = 'a-sufficiently-long-password';
    let email: string;

    beforeAll(async () => {
      const { PasswordService } = await import('../../src/auth/services/password.service');
      email = `staff-${Date.now()}@example.test`;

      await prisma.user.create({
        data: {
          email,
          fullName: 'Test Staff',
          passwordHash: await new PasswordService().hash(password),
        },
      });
    });

    it('issues tokens for correct credentials', async () => {
      const response = await http()
        .post('/api/v1/auth/staff/login')
        .send({ email, password })
        .expect(200);

      expect((response.body as Tokens).accessToken).toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      await http()
        .post('/api/v1/auth/staff/login')
        .send({ email, password: 'a-completely-wrong-password' })
        .expect(401);
    });

    it('gives the same answer for a wrong password and an unknown address', async () => {
      const wrongPassword = await http()
        .post('/api/v1/auth/staff/login')
        .send({ email, password: 'a-completely-wrong-password' })
        .expect(401);

      const unknownEmail = await http()
        .post('/api/v1/auth/staff/login')
        .send({ email: 'nobody@example.test', password: 'a-completely-wrong-password' })
        .expect(401);

      expect((wrongPassword.body as ErrorBody).message).toBe(
        (unknownEmail.body as ErrorBody).message,
      );
    });

    it('never stores the password in a recoverable form', async () => {
      const user = await prisma.user.findFirstOrThrow({ where: { email } });

      expect(user.passwordHash).not.toContain(password);
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('refuses a deactivated account', async () => {
      const deactivatedEmail = `inactive-${Date.now()}@example.test`;
      const { PasswordService } = await import('../../src/auth/services/password.service');

      await prisma.user.create({
        data: {
          email: deactivatedEmail,
          fullName: 'Inactive Staff',
          passwordHash: await new PasswordService().hash(password),
          isActive: false,
        },
      });

      await http()
        .post('/api/v1/auth/staff/login')
        .send({ email: deactivatedEmail, password })
        .expect(401);
    });
  });

  describe('protected routes', () => {
    it('refuses a request with no token', async () => {
      const response = await http().get('/api/v1/auth/me').expect(401);

      expect((response.body as ErrorBody).code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('refuses a forged token', async () => {
      await http()
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
    });

    it('refuses a token signed with the wrong key', async () => {
      const jwt = await import('jsonwebtoken');
      const forged = jwt.sign({ sub: 'someone', typ: 'STAFF', jti: 'x' }, 'the-wrong-signing-key');

      await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('ignores a non-bearer authorization scheme', async () => {
      await http().get('/api/v1/auth/me').set('Authorization', 'Basic dXNlcjpwYXNz').expect(401);
    });

    it('accepts a valid token and describes the actor', async () => {
      const phone = uniquePhone();
      const tokens = await loginCustomer(phone);

      const response = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      const actor = response.body as ActorBody;

      expect(actor.kind).toBe('CUSTOMER');
      expect(actor.phone).toBe(phone);
      expect(actor.permissions).toEqual([]);
      expect(actor.branchScope.kind).toBe('NONE');
    });

    it('reflects a revoked account on the very next request', async () => {
      const phone = uniquePhone();
      const tokens = await loginCustomer(phone);

      await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      await prisma.customer.update({ where: { phone }, data: { isActive: false } });

      // The token is still cryptographically valid and unexpired. Because
      // authorization is resolved from the database per request rather than
      // read from the token, deactivation takes effect immediately.
      await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);
    });
  });

  describe('refresh token rotation', () => {
    it('exchanges a refresh token for a new pair', async () => {
      const tokens = await loginCustomer(uniquePhone());

      const response = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const rotated = response.body as Tokens;
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      expect(rotated.accessToken).toBeTruthy();
    });

    it('invalidates the old refresh token once rotated', async () => {
      const tokens = await loginCustomer(uniquePhone());

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      const tokens = await loginCustomer(uniquePhone());

      const first = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const current = (first.body as Tokens).refreshToken;

      // Replaying the spent token signals theft.
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      // So the successor the attacker did not have is killed too — logging out
      // both parties, which is correct once a credential is known compromised.
      await http().post('/api/v1/auth/refresh').send({ refreshToken: current }).expect(401);
    });

    it('stores only a hash of the refresh token', async () => {
      const tokens = await loginCustomer(uniquePhone());

      const stored = await prisma.refreshToken.findMany({ select: { tokenHash: true } });
      const hashes = stored.map((row) => row.tokenHash);

      expect(hashes).not.toContain(tokens.refreshToken);
    });

    it('rejects an unknown refresh token', async () => {
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) })
        .expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the session', async () => {
      const tokens = await loginCustomer(uniquePhone());

      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it('is idempotent and reveals nothing about an unknown token', async () => {
      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'b'.repeat(43) })
        .expect(204);
    });
  });
});
