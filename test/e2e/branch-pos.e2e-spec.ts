import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { PasswordService } from '../../src/auth/services/password.service';
import { AuthTestContext, createAuthTestApp, uniquePhone } from './helpers/auth-app';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface MenuBody {
  categories: { products: { id: string; name: string; isAvailable: boolean }[] }[];
}

interface OrderBody {
  id: string;
  orderNumber: string;
  referenceId: string;
  totalMinor: number;
}

interface OrderListBody {
  data: OrderBody[];
  meta: { total: number };
}

/**
 * The two Branch POS loops, driven over HTTP exactly as the POS drives them.
 *
 * These are deliberately e2e rather than service tests: what is being proven is
 * the *contract* the POS depends on — the paths, the query parameters and the
 * permission each route demands. A service-level test would pass even if the
 * route were mounted somewhere the app can't reach.
 *
 *   1. **Sold out.** A branch marks an item off; the menu says so and the item
 *      stops being orderable at that branch — but stays orderable at another.
 *   2. **Order lookup.** A branch finds a past order by the 12-digit reference
 *      printed on the customer's docket, and cannot reach another branch's.
 */
describe('Branch POS (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let http: () => ReturnType<typeof request>;

  let branchA: string;
  let branchB: string;
  let productId: string;
  let adminATokens: Tokens;
  let adminBTokens: Tokens;

  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    http = () => request(context.app.getHttpServer());

    const passwords = new PasswordService();
    const suffix = randomUUID().slice(0, 8);

    const [a, b] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `POSA-${suffix}`,
          name: 'POS Branch A',
          addressLine: '1 A Street',
          city: 'Riyadh',
          settings: { create: { acceptsPickup: true, autoAcceptOrders: true } },
        },
      }),
      prisma.branch.create({
        data: {
          code: `POSB-${suffix}`,
          name: 'POS Branch B',
          addressLine: '2 B Street',
          city: 'Jeddah',
          settings: { create: { acceptsPickup: true, autoAcceptOrders: true } },
        },
      }),
    ]);
    branchA = a.id;
    branchB = b.id;

    const category = await prisma.category.create({ data: { name: `POS Mains ${suffix}` } });
    const product = await prisma.product.create({
      data: {
        categoryId: category.id,
        name: 'Mixed Grill',
        sku: `POS-SKU-${suffix}`,
        basePriceMinor: 11_500,
      },
    });
    productId = product.id;

    await prisma.productAvailability.createMany({
      data: [
        { productId, branchId: branchA, isAvailable: true },
        { productId, branchId: branchB, isAvailable: true },
      ],
    });

    const role = await prisma.role.upsert({
      where: { name: 'BRANCH_ADMIN' },
      update: {},
      create: { name: 'BRANCH_ADMIN', isSystem: true },
    });

    // Exactly the permissions the POS's own role holds — no more, so a route
    // that needs something extra fails here rather than in a branch.
    const codes = ['menu:read', 'menu:availability', 'orders:read', 'orders:write'];
    for (const code of codes) {
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }

    const passwordHash = await passwords.hash(PASSWORD);
    const [adminA, adminB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `pos-a-${suffix}@example.test`,
          fullName: 'POS A',
          passwordHash,
          roles: { create: { roleId: role.id, branchId: branchA } },
        },
      }),
      prisma.user.create({
        data: {
          email: `pos-b-${suffix}@example.test`,
          fullName: 'POS B',
          passwordHash,
          roles: { create: { roleId: role.id, branchId: branchB } },
        },
      }),
    ]);

    adminATokens = await login(adminA.email);
    adminBTokens = await login(adminB.email);
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

  const auth = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });

  /** Places a counter order the way the POS does, returning it. */
  async function placeCounterOrder(tokens: Tokens, branchId: string): Promise<OrderBody> {
    const response = await http()
      .post('/api/v1/orders')
      .set(auth(tokens))
      .send({
        branchId,
        type: 'PICKUP',
        customerPhone: uniquePhone(),
        paymentMethod: 'CASH',
        cashCollected: true,
        items: [{ productId, quantity: 1 }],
      })
      .expect(201);

    return response.body as OrderBody;
  }

  function availabilityOf(body: MenuBody, id: string): boolean | undefined {
    return body.categories.flatMap((c) => c.products).find((p) => p.id === id)?.isAvailable;
  }

  describe('marking an item sold out', () => {
    afterEach(async () => {
      // Put the item back so each test starts from a sellable menu.
      await prisma.productAvailability.updateMany({
        where: { productId },
        data: { isAvailable: true, unavailableUntil: null },
      });
    });

    it('takes the item off this branch’s menu and refuses to sell it', async () => {
      // It sells before.
      const before = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      expect(availabilityOf(before.body as MenuBody, productId)).toBe(true);

      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false })
        .expect(200);

      // The menu still lists it — the customer app shows the whole catalogue —
      // but flagged, which is what stops both apps offering it.
      const after = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      expect(availabilityOf(after.body as MenuBody, productId)).toBe(false);

      // And the server is the real gate: a counter order for it is rejected.
      await http()
        .post('/api/v1/orders')
        .set(auth(adminATokens))
        .send({
          branchId: branchA,
          type: 'PICKUP',
          customerPhone: uniquePhone(),
          paymentMethod: 'CASH',
          cashCollected: true,
          items: [{ productId, quantity: 1 }],
        })
        .expect(400);
    });

    it('does not wipe the branch price when the counter marks it sold out', async () => {
      // The Branch POS sold-out toggle sends nothing but `isAvailable`. This
      // used to be applied as `priceOverrideMinor: dto.x ?? null`, so every
      // sold-out toggle silently erased that branch's price for the item —
      // and nobody would notice until the next order charged the catalogue
      // price instead.
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: true, priceOverrideMinor: 9999 })
        .expect(200);

      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false })
        .expect(200);

      const row = await prisma.productAvailability.findFirst({
        where: { productId, branchId: branchA },
        select: { priceOverrideMinor: true },
      });
      expect(row?.priceOverrideMinor).toBe(9999);

      // An explicit null still clears it — that is how a price override is
      // meant to be removed.
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: true, priceOverrideMinor: null })
        .expect(200);

      const cleared = await prisma.productAvailability.findFirst({
        where: { productId, branchId: branchA },
        select: { priceOverrideMinor: true },
      });
      expect(cleared?.priceOverrideMinor).toBeNull();
    });

    it('sells it again by itself once the sold-out window passes', async () => {
      // "Sold out until 6pm" has to restore itself — a branch that has to
      // remember to switch every item back on will not, and the menu quietly
      // shrinks over a week of service.
      const soon = new Date(Date.now() + 60_000).toISOString();

      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false, unavailableUntil: soon })
        .expect(200);

      const during = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      expect(availabilityOf(during.body as MenuBody, productId)).toBe(false);

      // Move the window into the past rather than waiting a minute for it.
      await prisma.productAvailability.updateMany({
        where: { productId, branchId: branchA },
        data: { unavailableUntil: new Date(Date.now() - 1000) },
      });

      const after = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      expect(availabilityOf(after.body as MenuBody, productId)).toBe(true);

      // And it really is sellable again, not merely flagged so.
      await placeCounterOrder(adminATokens, branchA);
    });

    it('refuses a sold-out window that is not a date', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false, unavailableUntil: 'this evening' })
        .expect(400);
    });

    it('leaves the other branch selling it', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false })
        .expect(200);

      const other = await http().get(`/api/v1/branches/${branchB}/menu`).expect(200);
      expect(availabilityOf(other.body as MenuBody, productId)).toBe(true);

      await placeCounterOrder(adminBTokens, branchB);
    });

    it('puts it back on sale', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false })
        .expect(200);
      await http()
        .patch(`/api/v1/menu/branches/${branchA}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: true })
        .expect(200);

      const menu = await http().get(`/api/v1/branches/${branchA}/menu`).expect(200);
      expect(availabilityOf(menu.body as MenuBody, productId)).toBe(true);

      await placeCounterOrder(adminATokens, branchA);
    });

    it('refuses a branch reaching into another branch’s availability', async () => {
      await http()
        .patch(`/api/v1/menu/branches/${branchB}/products/${productId}/availability`)
        .set(auth(adminATokens))
        .send({ isAvailable: false })
        .expect(403);

      const menu = await http().get(`/api/v1/branches/${branchB}/menu`).expect(200);
      expect(availabilityOf(menu.body as MenuBody, productId)).toBe(true);
    });
  });

  describe('looking an order up', () => {
    it('finds it by the 12-digit reference printed on the docket', async () => {
      const order = await placeCounterOrder(adminATokens, branchA);
      expect(order.referenceId).toMatch(/^[1-9][0-9]{11}$/);

      const response = await http()
        .get(`/api/v1/orders?branchId=${branchA}&limit=30&search=${order.referenceId}`)
        .set(auth(adminATokens))
        .expect(200);

      const body = response.body as OrderListBody;
      expect(body.data.map((o) => o.id)).toEqual([order.id]);
    });

    it('finds it from a partial reference and by the branch order number', async () => {
      const order = await placeCounterOrder(adminATokens, branchA);

      const partial = await http()
        .get(`/api/v1/orders?branchId=${branchA}&limit=30&search=${order.referenceId.slice(0, 5)}`)
        .set(auth(adminATokens))
        .expect(200);
      expect((partial.body as OrderListBody).data.some((o) => o.id === order.id)).toBe(true);

      const byNumber = await http()
        .get(`/api/v1/orders?branchId=${branchA}&limit=30&search=${order.orderNumber}`)
        .set(auth(adminATokens))
        .expect(200);
      expect((byNumber.body as OrderListBody).data.some((o) => o.id === order.id)).toBe(true);
    });

    it('opens the found order in full', async () => {
      const order = await placeCounterOrder(adminATokens, branchA);

      const response = await http()
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(adminATokens))
        .expect(200);

      expect((response.body as OrderBody).referenceId).toBe(order.referenceId);
    });

    it('never surfaces another branch’s order, even given its exact reference', async () => {
      const order = await placeCounterOrder(adminATokens, branchA);

      const search = await http()
        .get(`/api/v1/orders?limit=30&search=${order.referenceId}`)
        .set(auth(adminBTokens))
        .expect(200);
      expect((search.body as OrderListBody).data).toHaveLength(0);

      // Nor by naming the other branch outright, nor by opening it directly.
      await http()
        .get(`/api/v1/orders?branchId=${branchA}&search=${order.referenceId}`)
        .set(auth(adminBTokens))
        .expect(403);

      await http().get(`/api/v1/orders/${order.id}`).set(auth(adminBTokens)).expect(403);
    });
  });
});
