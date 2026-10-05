import { PrismaClient } from '@prisma/client';

import { createCustomer, unique } from './helpers/factories';

/**
 * Database-level guarantees behind authentication.
 */
describe('Auth schema constraints (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const staffUser = () =>
    prisma.user.create({
      data: {
        email: `${unique('staff')}@example.test`,
        fullName: 'Test Staff',
        passwordHash: 'not-a-real-hash',
      },
    });

  const tokenDefaults = () => ({
    tokenHash: unique('hash'),
    familyId: unique('family'),
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  describe('refresh token ownership', () => {
    it('accepts a token owned by a staff user', async () => {
      const user = await staffUser();

      await expect(
        prisma.refreshToken.create({ data: { ...tokenDefaults(), userId: user.id } }),
      ).resolves.toBeDefined();
    });

    it('accepts a token owned by a customer', async () => {
      const customer = await createCustomer(prisma);

      await expect(
        prisma.refreshToken.create({ data: { ...tokenDefaults(), customerId: customer.id } }),
      ).resolves.toBeDefined();
    });

    it('refuses a token belonging to both a staff user and a customer', async () => {
      const [user, customer] = await Promise.all([staffUser(), createCustomer(prisma)]);

      // Enforced by the RefreshToken_exactly_one_owner CHECK constraint, so it
      // holds even against a script or a psql session, not just the API.
      await expect(
        prisma.refreshToken.create({
          data: { ...tokenDefaults(), userId: user.id, customerId: customer.id },
        }),
      ).rejects.toThrow();
    });

    it('refuses an ownerless token', async () => {
      await expect(prisma.refreshToken.create({ data: tokenDefaults() })).rejects.toThrow();
    });
  });

  describe('refresh token uniqueness', () => {
    it('refuses two tokens with the same hash', async () => {
      const user = await staffUser();
      const tokenHash = unique('hash');

      await prisma.refreshToken.create({
        data: { ...tokenDefaults(), tokenHash, userId: user.id },
      });

      await expect(
        prisma.refreshToken.create({ data: { ...tokenDefaults(), tokenHash, userId: user.id } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('session lifecycle', () => {
    it('removes a user’s sessions when the account is deleted', async () => {
      const user = await staffUser();
      await prisma.refreshToken.create({ data: { ...tokenDefaults(), userId: user.id } });

      await prisma.user.delete({ where: { id: user.id } });

      await expect(prisma.refreshToken.count({ where: { userId: user.id } })).resolves.toBe(0);
    });
  });

  describe('OTP challenges', () => {
    it('starts unconsumed with a zero attempt count', async () => {
      const challenge = await prisma.otpChallenge.create({
        data: {
          phone: '+966500000000',
          codeHash: 'not-a-real-hash',
          expiresAt: new Date(Date.now() + 300_000),
        },
      });

      expect(challenge.attempts).toBe(0);
      expect(challenge.consumedAt).toBeNull();
      expect(challenge.invalidatedAt).toBeNull();
      expect(challenge.purpose).toBe('CUSTOMER_LOGIN');
    });

    it('lets exactly one of two concurrent consumptions win', async () => {
      const challenge = await prisma.otpChallenge.create({
        data: {
          phone: '+966500000001',
          codeHash: 'not-a-real-hash',
          expiresAt: new Date(Date.now() + 300_000),
        },
      });

      // The conditional update the OTP service relies on: whoever updates a row
      // that is still unconsumed wins, and the loser sees a zero count rather
      // than a second successful login.
      const consume = () =>
        prisma.otpChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });

      const [first, second] = await Promise.all([consume(), consume()]);

      expect(first.count + second.count).toBe(1);
    });
  });
});
