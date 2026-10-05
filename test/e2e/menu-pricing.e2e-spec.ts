import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { PasswordService } from '../../src/auth/services/password.service';
import { ErrorCode } from '../../src/common/constants/error-codes';
import { AuthTestContext, createAuthTestApp, uniquePhone } from './helpers/auth-app';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

interface QuoteBody {
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  taxableBaseMinor: number;
  vatMinor: number;
  totalMinor: number;
  vatRate: string;
  lines: { productName: string; unitPriceMinor: number; lineTotalMinor: number }[];
  fees: { kind: string; totalMinor: number }[];
}

interface MenuBody {
  branch: { id: string; name: string };
  deliveryFeeMinor: number;
  categories: {
    id: string;
    name: string;
    products: { id: string; name: string; priceMinor: number; isAvailable: boolean }[];
  }[];
}

describe('Menu and pricing (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let http: () => ReturnType<typeof request>;

  // Seeded fixtures
  let branchA: string;
  let branchB: string;
  let categoryId: string;
  let productId: string;
  let ownerTokens: Tokens;
  let branchAdminTokens: Tokens;
  let customerTokens: Tokens;

  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    http = () => request(context.app.getHttpServer());

    const passwords = new PasswordService();
    const suffix = randomUUID().slice(0, 8);

    // Two branches, so isolation can be tested rather than assumed.
    const [a, b] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `BRA-${suffix}`,
          name: 'Branch A',
          addressLine: '1 A Street',
          city: 'Riyadh',
          settings: { create: { deliveryFeeMinor: 1150, acceptsDelivery: true } },
        },
      }),
      prisma.branch.create({
        data: {
          code: `BRB-${suffix}`,
          name: 'Branch B',
          addressLine: '2 B Street',
          city: 'Jeddah',
          settings: { create: { deliveryFeeMinor: 2300, acceptsDelivery: true } },
        },
      }),
    ]);
    branchA = a.id;
    branchB = b.id;

    const category = await prisma.category.create({ data: { name: `Mains ${suffix}` } });
    categoryId = category.id;

    // 115.00 SAR inclusive of VAT => 100.00 net + 15.00 tax.
    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Grilled Chicken',
        sku: `SKU-${suffix}`,
        basePriceMinor: 11_500,
      },
    });
    productId = product.id;

    await prisma.productAvailability.createMany({
      data: [
        { productId, branchId: branchA, isAvailable: true },
        { productId, branchId: branchB, isAvailable: true, priceOverrideMinor: 13_800 },
      ],
    });

    const [ownerRole, branchAdminRole] = await Promise.all([
      prisma.role.upsert({
        where: { name: 'OWNER' },
        update: {},
        create: { name: 'OWNER', isSystem: true },
      }),
      prisma.role.upsert({
        where: { name: 'BRANCH_ADMIN' },
        update: {},
        create: { name: 'BRANCH_ADMIN', isSystem: true },
      }),
    ]);

    // Grant the permissions these tests exercise.
    const codes = ['menu:read', 'menu:write', 'menu:availability'];
    const permissions = await Promise.all(
      codes.map((code) =>
        prisma.permission.upsert({ where: { code }, update: {}, create: { code } }),
      ),
    );

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: ownerRole.id, permissionId: permission.id } },
        update: {},
        create: { roleId: ownerRole.id, permissionId: permission.id },
      });
    }

    // The branch admin gets read and availability, deliberately NOT menu:write.
    for (const permission of permissions.filter((p) => p.code !== 'menu:write')) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: branchAdminRole.id, permissionId: permission.id } },
        update: {},
        create: { roleId: branchAdminRole.id, permissionId: permission.id },
      });
    }

    const passwordHash = await passwords.hash(PASSWORD);

    const owner = await prisma.user.create({
      data: {
        email: `owner-${suffix}@example.test`,
        fullName: 'Owner',
        passwordHash,
        roles: { create: { roleId: ownerRole.id, branchId: null } },
      },
    });

    const branchAdmin = await prisma.user.create({
      data: {
        email: `admin-${suffix}@example.test`,
        fullName: 'Branch A Admin',
        passwordHash,
        roles: { create: { roleId: branchAdminRole.id, branchId: branchA } },
      },
    });

    ownerTokens = await login(owner.email);
    branchAdminTokens = await login(branchAdmin.email);
    customerTokens = await loginCustomer();
  });

  afterAll(async () => {
    await context?.close();
  });

  async function login(email: string): Promise<Tokens> {
    const response = await http()
      .post('/api/v1/auth/staff/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return response.body as Tokens;
  }

  async function loginCustomer(): Promise<Tokens> {
    const phone = uniquePhone();
    await http().post('/api/v1/auth/customer/otp/request').send({ phone }).expect(200);
    const code = context.sms.lastCodeFor(phone);

    const response = await http()
      .post('/api/v1/auth/customer/otp/verify')
      .send({ phone, code })
      .expect(200);

    return response.body as Tokens;
  }

  const auth = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });

  describe('customer menu', () => {
    it('is browsable without signing in', async () => {
      // Customers browse before they have an account; a menu is public.
      const response = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);

      const body = response.body as MenuBody;
      expect(body.branch.id).toBe(branchA);
      expect(body.categories.some((c) => c.products.some((p) => p.id === productId))).toBe(true);
    });

    it('applies the branch price override', async () => {
      const [a, b] = await Promise.all([
        http().get(`/api/v1/branches/${branchA}/menu`).expect(200),
        http().get(`/api/v1/branches/${branchB}/menu`).expect(200),
      ]);

      const priceIn = (body: MenuBody) =>
        body.categories.flatMap((c) => c.products).find((p) => p.id === productId)?.priceMinor;

      expect(priceIn(a.body as MenuBody)).toBe(11_500);
      expect(priceIn(b.body as MenuBody)).toBe(13_800);
    });

    it('reports the branch delivery fee', async () => {
      const response = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);

      expect((response.body as MenuBody).deliveryFeeMinor).toBe(1150);
    });

    it('404s for an unknown branch', async () => {
      await http().get(`/api/v1/branches/${randomUUID()}/menu`).expect(404);
    });

    it('still lists a product the branch has marked off, flagged unavailable', async () => {
      const suffix = randomUUID().slice(0, 8);
      const hidden = await prisma.product.create({
        data: { categoryId, name: `Hidden ${suffix}`, sku: `H-${suffix}`, basePriceMinor: 5000 },
      });
      await prisma.productAvailability.create({
        data: { productId: hidden.id, branchId: branchA, isAvailable: false },
      });

      const response = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      const products = (response.body as MenuBody).categories.flatMap((c) => c.products);

      // The menu shows the whole catalogue and marks what the branch cannot
      // make right now, rather than silently dropping it — a customer who
      // cannot find a dish at all assumes the restaurant stopped selling it.
      const listed = products.find((p) => p.id === hidden.id);
      expect(listed).toBeDefined();
      expect(listed?.isAvailable).toBe(false);
    });
  });

  describe('pricing a cart', () => {
    it('prices a single item VAT-inclusive at 15%', async () => {
      const response = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
        .expect(200);

      const quote = response.body as QuoteBody;

      expect(quote.totalMinor).toBe(11_500);
      expect(quote.taxableBaseMinor).toBe(10_000);
      expect(quote.vatMinor).toBe(1500);
      expect(quote.vatRate).toBe('0.15');
    });

    it('adds the delivery fee and taxes it', async () => {
      const response = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'DELIVERY', items: [{ productId, quantity: 1 }] })
        .expect(200);

      const quote = response.body as QuoteBody;

      // 11500 + 1150 = 12650 inclusive
      expect(quote.deliveryFeeMinor).toBe(1150);
      expect(quote.totalMinor).toBe(12_650);
      expect(quote.taxableBaseMinor + quote.vatMinor).toBe(quote.totalMinor);
    });

    it('charges no delivery fee for pickup', async () => {
      const response = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 2 }] })
        .expect(200);

      const quote = response.body as QuoteBody;

      expect(quote.deliveryFeeMinor).toBe(0);
      expect(quote.fees).toHaveLength(0);
      expect(quote.totalMinor).toBe(23_000);
    });

    it('uses the branch price, so the same cart differs between branches', async () => {
      const [a, b] = await Promise.all([
        http()
          .post('/api/v1/pricing/quote')
          .set(auth(customerTokens))
          .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
          .expect(200),
        http()
          .post('/api/v1/pricing/quote')
          .set(auth(customerTokens))
          .send({ branchId: branchB, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
          .expect(200),
      ]);

      expect((a.body as QuoteBody).totalMinor).toBe(11_500);
      expect((b.body as QuoteBody).totalMinor).toBe(13_800);
    });

    it('ignores any price a client tries to send', async () => {
      // The decisive test for "the backend decides the payable amount".
      const response = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({
          branchId: branchA,
          type: 'PICKUP',
          items: [{ productId, quantity: 1, unitPriceMinor: 1, priceMinor: 1, totalMinor: 1 }],
        })
        .expect(400);

      // Unknown properties are rejected outright rather than quietly dropped,
      // so a tampered cart fails loudly instead of being silently corrected.
      expect((response.body as ErrorBody).code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('refuses the whole cart when an item is unavailable', async () => {
      const suffix = randomUUID().slice(0, 8);
      const offMenu = await prisma.product.create({
        data: { categoryId, name: `Off ${suffix}`, sku: `O-${suffix}`, basePriceMinor: 5000 },
      });
      await prisma.productAvailability.create({
        data: { productId: offMenu.id, branchId: branchA, isAvailable: false },
      });

      // Silently dropping it would charge the customer for less than they
      // believe they ordered.
      const response = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({
          branchId: branchA,
          type: 'PICKUP',
          items: [
            { productId, quantity: 1 },
            { productId: offMenu.id, quantity: 1 },
          ],
        })
        .expect(400);

      expect((response.body as ErrorBody).message).toContain('not available');
    });

    it('refuses a product the branch has turned off, and sells it where nobody has', async () => {
      // The catalogue is organisation-wide and availability is a per-branch
      // *override*. This test used to assert the opposite default — that a
      // product with no row at a branch could not be sold there — which made
      // every product created in the admin panel unorderable everywhere, since
      // a row is only written by the seed or by a branch switching something
      // off. Absence of an opinion is not an opinion.
      //
      // The guarantee that actually matters is unchanged and still asserted: a
      // branch that has switched something off cannot sell it. What flipped is
      // only what silence means.
      const suffix = randomUUID().slice(0, 8);
      const product = await prisma.product.create({
        data: { categoryId, name: `BOnly ${suffix}`, sku: `B-${suffix}`, basePriceMinor: 5000 },
      });
      await prisma.productAvailability.create({
        data: { productId: product.id, branchId: branchA, isAvailable: false },
      });

      // Branch A said no.
      await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({
          branchId: branchA,
          type: 'PICKUP',
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(400);

      // Branch B has no row at all, so it sells it.
      await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({
          branchId: branchB,
          type: 'PICKUP',
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(200);
    });

    it('requires authentication', async () => {
      await http()
        .post('/api/v1/pricing/quote')
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
        .expect(401);
    });

    it('rejects an empty cart', async () => {
      await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [] })
        .expect(400);
    });

    it('rejects an implausible quantity', async () => {
      await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 100_000 }] })
        .expect(400);
    });
  });

  describe('menu management permissions', () => {
    it('lets an owner create a product', async () => {
      const suffix = randomUUID().slice(0, 8);

      await http()
        .post('/api/v1/menu/products')
        .set(auth(ownerTokens))
        .send({ categoryId, name: `New ${suffix}`, sku: `N-${suffix}`, basePriceMinor: 4500 })
        .expect(201);
    });

    it('refuses a branch admin the organisation-wide catalog', async () => {
      const suffix = randomUUID().slice(0, 8);

      // A branch manager may take an item off for the evening, but must not be
      // able to change what the whole chain sells.
      const response = await http()
        .post('/api/v1/menu/products')
        .set(auth(branchAdminTokens))
        .send({ categoryId, name: `Nope ${suffix}`, sku: `X-${suffix}`, basePriceMinor: 4500 })
        .expect(403);

      expect((response.body as ErrorBody).code).toBe(ErrorCode.FORBIDDEN);
    });

    it('refuses a customer entirely', async () => {
      await http().get('/api/v1/menu/products').set(auth(customerTokens)).expect(403);
    });

    it('rejects a duplicate SKU', async () => {
      const suffix = randomUUID().slice(0, 8);
      const body = { categoryId, name: `Dup ${suffix}`, sku: `D-${suffix}`, basePriceMinor: 1000 };

      await http().post('/api/v1/menu/products').set(auth(ownerTokens)).send(body).expect(201);
      await http().post('/api/v1/menu/products').set(auth(ownerTokens)).send(body).expect(400);
    });

    it('refuses to delete a category that still holds products', async () => {
      await http()
        .delete(`/api/v1/menu/categories/${categoryId}`)
        .set(auth(ownerTokens))
        .expect(400);
    });
  });

  describe('branch isolation on availability', () => {
    it('lets a branch admin change their own branch', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(branchAdminTokens))
        .send({ isAvailable: true, priceOverrideMinor: 12_000 })
        .expect(200);
    });

    it('refuses a branch admin another branch', async () => {
      // The decisive branch-isolation test: a valid, permitted action aimed at
      // a branch the caller does not hold.
      const response = await http()
        .patch(`/api/v1/menu/branches/${branchB}/products/${productId}/availability`)
        .set(auth(branchAdminTokens))
        .send({ isAvailable: false })
        .expect(403);

      expect((response.body as ErrorBody).message).toBe('You do not have access to this branch.');
    });

    it('does not reveal whether the other branch exists', async () => {
      const real = await http()
        .patch(`/api/v1/menu/branches/${branchB}/products/${productId}/availability`)
        .set(auth(branchAdminTokens))
        .send({ isAvailable: false })
        .expect(403);

      const fabricated = await http()
        .patch(`/api/v1/menu/branches/${randomUUID()}/products/${productId}/availability`)
        .set(auth(branchAdminTokens))
        .send({ isAvailable: false })
        .expect(403);

      expect((real.body as ErrorBody).message).toBe((fabricated.body as ErrorBody).message);
    });

    it('lets an owner change any branch', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchB}/products/${productId}/availability`)
        .set(auth(ownerTokens))
        .send({ isAvailable: true, priceOverrideMinor: 13_800 })
        .expect(200);
    });

    it('refuses a branch admin listing another branch', async () => {
      await http()
        .get(`/api/v1/menu/branches/${branchB}/availability`)
        .set(auth(branchAdminTokens))
        .expect(403);
    });
  });

  describe('price changes do not rewrite history', () => {
    it('quotes the new price after an override, leaving the old quote unchanged', async () => {
      const before = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
        .expect(200);

      const beforeTotal = (before.body as QuoteBody).totalMinor;

      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(ownerTokens))
        .send({ isAvailable: true, priceOverrideMinor: 20_000 })
        .expect(200);

      const after = await http()
        .post('/api/v1/pricing/quote')
        .set(auth(customerTokens))
        .send({ branchId: branchA, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
        .expect(200);

      expect((after.body as QuoteBody).totalMinor).toBe(20_000);
      // The earlier quote is a snapshot; it is not retroactively repriced.
      expect(beforeTotal).not.toBe(20_000);
    });
  });
});
