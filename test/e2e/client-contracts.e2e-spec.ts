import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { PasswordService } from '../../src/auth/services/password.service';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '../../prisma/seed/permissions';
import { AuthTestContext, createAuthTestApp, uniquePhone } from './helpers/auth-app';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Every request a client app fires when a screen opens, run for real.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, which is right —
 * it stops a client smuggling a `price` or a `role` into a DTO. The cost is
 * that **one query parameter a DTO does not declare turns a whole screen into a
 * 400 VALIDATION_FAILED**, and nothing catches it: the client compiles, the
 * route exists, the permission is right, and the failure only appears when a
 * human opens that tab.
 *
 * So this suite is a contract test, not a feature test. For each screen it
 * sends the parameters that screen actually sends — read off the apps' API
 * clients, not invented here — and asserts the response is not a 4xx/5xx. It
 * deliberately asserts almost nothing about the *body*: what is under test is
 * that the section loads at all.
 *
 * When a client starts sending a new filter, add it here in the same commit.
 */
describe('Client screen contracts (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let http: () => ReturnType<typeof request>;

  let branchId: string;
  let productId: string;
  let categoryId: string;
  let customerId: string;
  let orderId: string;
  let deliveryOrderId: string;
  let driverId: string;
  let staffUserId: string;

  let owner: Tokens;
  let branchAdmin: Tokens;
  let kitchen: Tokens;
  let customer: Tokens;
  let driver: Tokens;

  const PASSWORD = 'a-sufficiently-long-password';
  const FROM = '2026-01-01';
  const TO = '2030-01-01';

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    http = () => request(context.app.getHttpServer());

    const passwords = new PasswordService();
    const suffix = randomUUID().slice(0, 8);

    const branch = await prisma.branch.create({
      data: {
        code: `CC-${suffix}`,
        name: 'Contract Branch',
        addressLine: '1 Contract Street',
        city: 'Riyadh',
        settings: {
          create: { acceptsPickup: true, acceptsDelivery: true, acceptsCashOnDelivery: true },
        },
      },
    });
    branchId = branch.id;

    const category = await prisma.category.create({ data: { name: `CC Mains ${suffix}` } });
    categoryId = category.id;

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Contract Grill',
        sku: `CC-SKU-${suffix}`,
        basePriceMinor: 11_500,
      },
    });
    productId = product.id;
    await prisma.productAvailability.create({
      data: { productId, branchId, isAvailable: true },
    });

    // Roles, seeded from the real permission map so this suite cannot pass on a
    // more generous grant than production actually gives these roles.
    const permissionCodes = new Set(Object.values(ROLE_PERMISSIONS).flatMap((codes) => codes));
    const permissions = new Map<string, string>();
    for (const code of permissionCodes) {
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code },
      });
      permissions.set(code, permission.id);
    }

    const roleIds = new Map<string, string>();
    for (const roleName of [
      SYSTEM_ROLES.OWNER,
      SYSTEM_ROLES.BRANCH_ADMIN,
      SYSTEM_ROLES.KITCHEN,
      SYSTEM_ROLES.DRIVER,
    ]) {
      const role = await prisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName, isSystem: true },
      });
      roleIds.set(roleName, role.id);

      for (const code of ROLE_PERMISSIONS[roleName] ?? []) {
        const permissionId = permissions.get(code);
        if (!permissionId) continue;
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          update: {},
          create: { roleId: role.id, permissionId },
        });
      }
    }

    const passwordHash = await passwords.hash(PASSWORD);

    const ownerUser = await prisma.user.create({
      data: {
        email: `cc-owner-${suffix}@example.test`,
        fullName: 'Contract Owner',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.OWNER)!, branchId: null } },
      },
    });
    staffUserId = ownerUser.id;

    const branchUser = await prisma.user.create({
      data: {
        email: `cc-branch-${suffix}@example.test`,
        fullName: 'Contract Branch Admin',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.BRANCH_ADMIN)!, branchId } },
      },
    });

    // The Branch POS is signed into by whichever staff member the owner gave
    // that branch's credentials to, and that is as often a KITCHEN user as a
    // BRANCH_ADMIN. Only the branch admin was covered here, so every request
    // the POS makes was proven for the wider role and assumed for the narrower
    // one — which is exactly how a counter terminal ends up showing "You do not
    // have permission to perform this action" that no test ever saw.
    const kitchenUser = await prisma.user.create({
      data: {
        email: `cc-kitchen-${suffix}@example.test`,
        fullName: 'Contract Kitchen',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.KITCHEN)!, branchId } },
      },
    });

    const driverUser = await prisma.user.create({
      data: {
        email: `cc-driver-${suffix}@example.test`,
        fullName: 'Contract Driver',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.DRIVER)!, branchId } },
      },
    });
    const driverRecord = await prisma.driver.create({
      data: { userId: driverUser.id, vehicleType: 'CAR' },
    });
    driverId = driverRecord.id;

    owner = await staffLogin(ownerUser.email);
    branchAdmin = await staffLogin(branchUser.email);
    kitchen = await staffLogin(kitchenUser.email);
    driver = await staffLogin(driverUser.email);
    customer = await customerLogin();

    // One real order, so detail screens have something to open rather than
    // proving only that an empty list is a 200.
    const placed = await http()
      .post('/api/v1/customer/orders')
      .set(auth(customer))
      .send({
        branchId,
        type: 'PICKUP',
        paymentMethod: 'CASH_ON_DELIVERY',
        items: [{ productId, quantity: 1 }],
      })
      .expect(201);
    orderId = (placed.body as { id: string }).id;

    const me = await http().get('/api/v1/customer/me').set(auth(customer)).expect(200);
    customerId = (me.body as { id: string }).id;

    // A delivery order driven to READY, so the customer tracking screen and the
    // deliveries boards have a real delivery to load rather than an empty list.
    const address = await http()
      .post('/api/v1/customer/addresses')
      .set(auth(customer))
      .send({ line1: '1 Tracking Street', city: 'Riyadh' })
      .expect(201);

    const deliveryOrder = await http()
      .post('/api/v1/customer/orders')
      .set(auth(customer))
      .send({
        branchId,
        type: 'DELIVERY',
        paymentMethod: 'CASH_ON_DELIVERY',
        customerAddressId: (address.body as { id: string }).id,
        items: [{ productId, quantity: 1 }],
      })
      .expect(201);
    deliveryOrderId = (deliveryOrder.body as { id: string }).id;

    await http()
      .post(`/api/v1/orders/${deliveryOrderId}/preparing`)
      .set(auth(branchAdmin))
      .expect(200);
    await http().post(`/api/v1/orders/${deliveryOrderId}/ready`).set(auth(branchAdmin)).expect(200);
  });

  afterAll(async () => {
    await context?.close();
  });

  async function staffLogin(email: string): Promise<Tokens> {
    const response = await http()
      .post('/api/v1/auth/staff/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return response.body as Tokens;
  }

  async function customerLogin(): Promise<Tokens> {
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

  /**
   * Fires one screen's request and fails loudly with the server's own message.
   *
   * A 400 here is the bug this suite exists to catch, so the assertion prints
   * the field the pipe rejected rather than just a status code.
   */
  async function loads(as: Tokens | null, path: string): Promise<void> {
    const req = http().get(`/api/v1${path}`);
    if (as) {
      req.set(auth(as));
    }
    const response = await req;

    if (response.status >= 400) {
      const body = JSON.stringify(response.body);
      throw new Error(`GET ${path} -> ${response.status}\n${body}`);
    }
  }

  // ===========================================================================
  // Customer app
  // ===========================================================================

  describe('customer app', () => {
    it('loads the branch list and a branch menu', async () => {
      await loads(null, '/customer/branches');
      await loads(null, `/branches/${branchId}/menu`);
    });

    it('loads the bootstrap config the home screen needs', async () => {
      // One public call carries the whole home screen: branches, banners,
      // homepage sections, promotions and feature flags. The /banners and
      // /homepage/sections routes themselves are the owner's management
      // surface and are correctly staff-only — covered under the admin app.
      await loads(null, '/customer/config');
    });

    /**
     * The order screen's refund panel. Two calls, because they answer different
     * questions: eligibility is what may be done *now*, the request list is what
     * happened to anything asked before. The list is filtered by `orderId`, and
     * a query parameter the DTO does not declare turns the panel into a 400.
     */
    it('loads the refund panel on the order screen', async () => {
      await loads(customer, `/customer/orders/${orderId}/refund-eligibility`);
      await loads(customer, `/customer/refund-requests?orderId=${orderId}`);
      await loads(customer, '/customer/refund-requests');
    });

    it('loads the account sections', async () => {
      await loads(customer, '/customer/me');
      await loads(customer, '/customer/addresses');
      await loads(customer, '/customer/loyalty');
      await loads(customer, '/customer/notifications');
    });

    it('has something in the notification feed once an order has been placed', async () => {
      // "Loads" was never the complaint about this screen — it was that it was
      // always empty. This asserts the whole chain the customer sees: an order
      // was placed in `beforeAll`, so a notification about it must be readable
      // from the feed the app opens.
      const response = await http()
        .get('/api/v1/customer/notifications')
        .set(auth(customer))
        .expect(200);

      const body = response.body as { data: { title: string; orderId: string | null }[] };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((n) => n.orderId === orderId)).toBe(true);
    });

    it('loads orders, one order and its payment', async () => {
      await loads(customer, '/customer/orders');
      await loads(customer, `/customer/orders/${orderId}`);
      await loads(customer, `/customer/orders/${orderId}/payment`);
    });

    it('tracks a delivery once the order has one', async () => {
      // The tracking screen only calls this for a DELIVERY order, and a
      // delivery row is opened by the order engine when the order reaches
      // READY — so both of those have to be true before it can load.
      await loads(customer, `/customer/orders/${deliveryOrderId}/delivery`);
    });

    it('returns a clean 404, not a validation error, for an order with no delivery', async () => {
      // A pickup order legitimately has no delivery. What matters is that the
      // app gets the documented 404 it handles, not a 400 or a 500.
      const response = await http()
        .get(`/api/v1/customer/orders/${orderId}/delivery`)
        .set(auth(customer));

      expect(response.status).toBe(404);
    });

    /**
     * The two routes a client is most likely to call in the wrong auth mode,
     * pinned in both directions.
     *
     * This block exists because asserting the *intended* contract here was not
     * enough on its own. The suite already pinned `/pricing/quote` as 401
     * without a token — correctly — and the customer app called it with its
     * `public` flag set anyway for months. A server-side test cannot police
     * what a client actually sends; what it can do is make the contract
     * unmissable, and fail loudly if someone "fixes" a client 401 by opening
     * the route instead of sending the token.
     *
     * So: if either assertion below starts failing, the fix is almost never to
     * change this test.
     */
    it('pins the auth mode of the two routes clients get wrong', async () => {
      // GET /branches is the STAFF branch resource. It carries `code` and
      // lifecycle `status` and requires branches:read. A customer app that
      // calls it unauthenticated gets a 401 and never renders a branch list —
      // which is every screen after sign-in, since branch selection gates the
      // menu, the cart and checkout.
      await http().get('/api/v1/branches').expect(401);
      await http().get('/api/v1/branches').set(auth(owner)).expect(200);

      // The customer-facing list is a different route with a different
      // projection, and it is public. Nest does not warn about two controllers
      // serving related paths, so the only thing keeping these straight is
      // this assertion.
      await http().get('/api/v1/customer/branches').expect(200);

      // Pricing is NOT public in either direction.
      const body = { branchId, type: 'PICKUP', items: [{ productId, quantity: 1 }] };
      await http().post('/api/v1/pricing/quote').send(body).expect(401);
      await http().post('/api/v1/pricing/quote').set(auth(customer)).send(body).expect(200);
    });

    it('places one order per idempotency key, however many times it is retried', async () => {
      // A checkout request that reaches the server and whose response is lost
      // is indistinguishable at the client from one that never arrived. The
      // customer retries, and without a key that is a second real order and a
      // second charge. The customer app sends one key per checkout attempt.
      const key = `contract-${randomUUID()}`;
      const body = {
        branchId,
        type: 'PICKUP',
        paymentMethod: 'CASH_ON_DELIVERY',
        items: [{ productId, quantity: 1 }],
      };

      const first = await http()
        .post('/api/v1/customer/orders')
        .set(auth(customer))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      const replay = await http()
        .post('/api/v1/customer/orders')
        .set(auth(customer))
        .set('Idempotency-Key', key)
        .send(body);

      const firstBody = first.body as { id: string; orderNumber: string };
      const replayBody = replay.body as { id: string; orderNumber: string };
      expect(replayBody.id).toBe(firstBody.id);
      expect(replayBody.orderNumber).toBe(firstBody.orderNumber);
    });

    it('ends the session on sign-out, rather than leaving the refresh token live', async () => {
      // Clearing a token locally is not signing out: the refresh family stays
      // valid for its full 30 days, so a shared, sold or lost phone keeps a
      // working session. Every client calls this on sign-out — the customer app
      // did not, and cleared local state only.
      const session = await customerLogin();

      // Live before sign-out...
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      // ...and revoked after it. The refresh above rotated the token, so sign
      // out with the token the client now holds, exactly as the app does.
      const rotated = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      const current = (rotated.body as Tokens).refreshToken ?? session.refreshToken;

      await http().post('/api/v1/auth/logout').send({ refreshToken: current }).expect(204);
      await http().post('/api/v1/auth/refresh').send({ refreshToken: current }).expect(401);
    });

    it('prices a cart — authenticated, which is what the checkout screen depends on', async () => {
      const body = { branchId, type: 'PICKUP', items: [{ productId, quantity: 1 }] };

      // Pricing is NOT public. A client that omits the token gets a 401, which
      // reads as "Couldn't price your order" and blocks checkout outright.
      await http().post('/api/v1/pricing/quote').send(body).expect(401);
      await http().post('/api/v1/pricing/quote').set(auth(customer)).send(body).expect(200);

      // The coupon-aware quote takes a code that does not resolve without
      // failing — the base price still comes back, so totals never vanish
      // while someone is fixing a typo.
      await http()
        .post('/api/v1/customer/orders/quote')
        .set(auth(customer))
        .send({ ...body, couponCode: 'NOT-A-REAL-COUPON' })
        .expect(200);
    });

    it('accepts the delivery address the checkout screen sends with a quote', async () => {
      // The customer app started sending `customerAddressId` with every
      // delivery quote, because the fee is priced from that address's distance
      // to the branch. `forbidNonWhitelisted` is on: if the DTO did not declare
      // it, this whole request would be a 400 and the checkout screen would
      // read "Couldn't price your order" with no total at all.
      const address = await prisma.customerAddress.create({
        data: {
          customerId,
          line1: '1 Test St',
          city: 'Riyadh',
          latitude: 24.7118,
          longitude: 46.6745,
        },
      });

      const response = await http()
        .post('/api/v1/customer/orders/quote')
        .set(auth(customer))
        .send({
          branchId,
          type: 'DELIVERY',
          items: [{ productId, quantity: 1 }],
          customerAddressId: address.id,
        })
        .expect(200);

      // The quote carries how the fee was reached, which is what the summary
      // renders — and what a quote that only returned a number could not.
      const quoted = response.body as { breakdown?: unknown };
      expect(Array.isArray(quoted.breakdown)).toBe(true);
    });
  });

  // ===========================================================================
  // Branch POS
  // ===========================================================================

  describe('branch POS', () => {
    it('loads the queues', async () => {
      await loads(branchAdmin, `/orders/kitchen/queue?branchId=${branchId}`);
      await loads(branchAdmin, `/orders/awaiting-acceptance/queue?branchId=${branchId}`);
    });

    it('loads every POS screen as a KITCHEN user too, not only as a branch admin', async () => {
      await loads(kitchen, '/auth/me');
      await loads(kitchen, `/orders/kitchen/queue?branchId=${branchId}`);
      await loads(kitchen, `/orders/awaiting-acceptance/queue?branchId=${branchId}`);
      await loads(kitchen, `/orders?branchId=${branchId}&limit=30`);
      await loads(kitchen, `/orders?branchId=${branchId}&limit=30&search=1000000`);
      await loads(kitchen, `/orders/${orderId}`);
      await loads(kitchen, `/deliveries?branchId=${branchId}&limit=100`);
      // The POS **board** now dispatches a ready delivery order itself, so it
      // asks for the branch's unassigned deliveries alongside its two queues.
      // That is a filter this client did not previously send, and with
      // `forbidNonWhitelisted` on, one the DTO did not declare would turn the
      // whole board into a 400 that reads as "the orders won't load".
      await loads(kitchen, `/deliveries?branchId=${branchId}&limit=100&status=PENDING_ASSIGNMENT`);
      // The counter's assign dialog asks for everyone **on shift**, not only
      // the free ones: a busy driver can now be given another drop, and
      // filtering to `isAvailable` hid the person already riding to that
      // street. See `kitchen-pos/src/api/endpoints.ts`.
      await loads(kitchen, '/drivers?limit=100&isOnline=true');
      await loads(kitchen, `/branches/${branchId}/menu`);
      await loads(kitchen, `/menu/branches/${branchId}/availability`);
      // Whether prints will be signed — the setup screen says which of the two
      // states the branch is in rather than leaving it to a dialog mid-service.
      await loads(kitchen, '/printing/qz/status');
      // The POS prints the customer docket, so it reads the template it prints.
      // A 403 here would not fail a screen — it would print last month's
      // layout, or nothing, with nobody at the counter able to tell why.
      await loads(kitchen, `/receipt-templates/branches/${branchId}`);
      // The POS Reports tab. `reports:read` is the one financial permission the
      // KITCHEN role holds (see prisma/seed/permissions.ts), and this is the
      // assertion that it actually does — a counter account that cannot read
      // its own branch's takings gets a 403 on a tab it was offered, which is
      // the failure this whole suite exists to catch.
      await loads(kitchen, `/reports/sales?from=${FROM}&to=${TO}`);
      await loads(kitchen, `/reports/vat?from=${FROM}&to=${TO}`);
      await loads(kitchen, `/reports/payments?from=${FROM}&to=${TO}`);
      await loads(kitchen, `/reports/dashboard-kpis?from=${FROM}&to=${TO}`);
      // And with the branch named, which is what the POS actually sends: the
      // server would scope it to this branch anyway, but the request carries it
      // so the figures cannot silently widen if the account ever spans two.
      await loads(kitchen, `/reports/sales?from=${FROM}&to=${TO}&branchId=${branchId}`);
      await loads(kitchen, `/reports/vat?from=${FROM}&to=${TO}&branchId=${branchId}`);
      await loads(kitchen, `/reports/payments?from=${FROM}&to=${TO}&branchId=${branchId}`);
      await loads(kitchen, `/reports/dashboard-kpis?from=${FROM}&to=${TO}&branchId=${branchId}`);
    });

    it('loads order lookup, with and without a search', async () => {
      await loads(branchAdmin, `/orders?branchId=${branchId}&limit=30`);
      await loads(branchAdmin, `/orders?branchId=${branchId}&limit=30&search=1000000`);
      await loads(branchAdmin, `/orders/${orderId}`);
    });

    it('loads deliveries and drivers for assignment', async () => {
      await loads(branchAdmin, `/deliveries?branchId=${branchId}&limit=100`);
      await loads(branchAdmin, '/drivers?limit=100&isOnline=true');
    });

    it('prices a counter cart — authenticated, like the customer app', async () => {
      await http()
        .post('/api/v1/pricing/quote')
        .set(auth(branchAdmin))
        .send({ branchId, type: 'PICKUP', items: [{ productId, quantity: 1 }] })
        .expect(200);
    });

    it('loads the menu it toggles availability on', async () => {
      await loads(branchAdmin, `/branches/${branchId}/menu`);
      await loads(branchAdmin, `/menu/branches/${branchId}/availability`);
    });
  });

  // ===========================================================================
  // Admin app — every page's initial load
  // ===========================================================================

  describe('admin app', () => {
    it('loads the identity and branch sections', async () => {
      await loads(owner, '/auth/me');
      await loads(owner, '/branches');
      // The staff list must carry the fields the Branches page acts on. It
      // previously returned the public projection — a different route had
      // shadowed this one — leaving the status chip blank and the lifecycle
      // buttons wrong.
      const branches = await http().get('/api/v1/branches').set(auth(owner));
      const [first] = branches.body as { status?: string; code?: string }[];
      expect(first).toHaveProperty('status');
      expect(first).toHaveProperty('code');
      await loads(owner, `/branches/${branchId}`);
      await loads(owner, `/branches/${branchId}/settings`);
      await loads(owner, `/branches/${branchId}/hours`);
      // The Print tab: the owner's docket template, the built-in one behind
      // its Reset, and what one branch actually prints.
      await loads(owner, '/receipt-templates/default');
      await loads(owner, '/receipt-templates/shipped');
      await loads(owner, `/receipt-templates/branches/${branchId}`);
      await loads(owner, `/branches/${branchId}/hours/open`);
    });

    it('loads the orders pages', async () => {
      await loads(owner, '/orders?limit=25');
      await loads(owner, `/orders?limit=25&branchId=${branchId}&status=CONFIRMED`);
      await loads(owner, `/orders?limit=25&customerId=${customerId}&page=1`);
      await loads(owner, `/orders/${orderId}`);
      await loads(owner, `/orders/${orderId}/edits`);
    });

    it('loads the menu pages', async () => {
      await loads(owner, '/menu/categories?includeInactive=true');
      await loads(owner, '/menu/products?includeInactive=true');
      await loads(owner, `/menu/products?categoryId=${categoryId}&includeInactive=true`);
      await loads(owner, `/menu/products/${productId}`);
      await loads(owner, '/menu/modifier-groups?includeInactive=true');
    });

    it('loads the money pages', async () => {
      await loads(owner, '/payments?limit=25');
      await loads(owner, `/payments?limit=25&branchId=${branchId}&status=PAID&page=1`);
      await loads(owner, '/refunds?limit=25');
      await loads(owner, `/refunds?limit=25&branchId=${branchId}&status=COMPLETED`);
      // The Refunds page: the queue of customer requests, and its filters.
      await loads(owner, '/refund-requests?limit=50&status=PENDING');
      await loads(owner, `/refund-requests?limit=50&branchId=${branchId}`);
      await loads(owner, '/refund-requests?limit=50&type=CANCELLATION');
      // The owner's payout queue: approved, and the money not yet sent.
      await loads(owner, '/refund-requests?limit=50&awaitingPayout=true');
      await loads(owner, '/refund-requests?limit=50&awaitingPayout=false');
      // A branch admin holds `refunds:read`, and their own queue is a tab in
      // their nav — so this must load for them too, not only for an owner.
      await loads(branchAdmin, '/refund-requests?limit=50&status=PENDING');
      await loads(owner, '/settlements?limit=25');
      await loads(owner, `/settlements?limit=25&branchId=${branchId}&status=MATCHED`);
    });

    it('loads the reports pages', async () => {
      for (const report of [
        'sales',
        'vat',
        'payments',
        'charges',
        'drivers',
        'dashboard-kpis',
        // The only view of what the refund windows *prevented*.
        'refund-window-misses',
      ]) {
        await loads(owner, `/reports/${report}?from=${FROM}&to=${TO}`);
        await loads(owner, `/reports/${report}?from=${FROM}&to=${TO}&branchId=${branchId}`);
      }
    });

    it('loads the growth pages', async () => {
      await loads(owner, '/coupons?limit=25');
      await loads(owner, `/loyalty/${customerId}?limit=50`);
      await loads(owner, '/banners');
      await loads(owner, '/promotions');
      await loads(owner, '/homepage/sections');
      await loads(owner, '/charges');
      await loads(owner, '/feature-flags');
    });

    it('loads the people pages', async () => {
      await loads(owner, '/users?limit=25');
      await loads(owner, `/users/${staffUserId}`);
      await loads(owner, '/customers?limit=25');
      await loads(owner, `/customers?limit=25&q=${encodeURIComponent('+9665')}&page=1`);
      await loads(owner, `/customers/${customerId}`);
      await loads(owner, '/drivers?limit=50');
      await loads(owner, `/drivers/${driverId}`);
      // The admin panel's picker (`Api.assignableDrivers`) and Live Ops.
      await loads(owner, '/drivers?isOnline=true&limit=100');
    });

    it('loads the operations pages', async () => {
      await loads(owner, '/deliveries?limit=100');
      await loads(owner, `/deliveries?limit=100&branchId=${branchId}&status=PENDING_ASSIGNMENT`);
      await loads(owner, '/deliveries/cash-collections?limit=50');
      await loads(
        owner,
        `/deliveries/cash-collections?limit=50&branchId=${branchId}&from=${FROM}&to=${TO}`,
      );
      await loads(owner, '/audit?limit=25');
      await loads(owner, `/audit?limit=25&branchId=${branchId}&from=${FROM}&to=${TO}&page=1`);
    });

    it('loads the branch-admin subset as a branch admin, not just as the owner', async () => {
      // The branch view is the same binary with a narrower role: a filter the
      // owner may pass and a branch admin may not is a broken screen for them.
      await loads(branchAdmin, '/auth/me');
      await loads(branchAdmin, `/orders?limit=25&branchId=${branchId}`);
      await loads(branchAdmin, `/deliveries?limit=100&branchId=${branchId}`);
      await loads(branchAdmin, `/reports/sales?from=${FROM}&to=${TO}&branchId=${branchId}`);
      await loads(branchAdmin, `/branches/${branchId}/settings`);
    });
  });

  // ===========================================================================
  // Driver app
  // ===========================================================================

  describe('driver app', () => {
    it('loads the driver’s own sections', async () => {
      await loads(driver, '/driver/me');
      await loads(driver, '/driver/deliveries');
      await loads(driver, '/driver/deliveries?status=DELIVERED');
    });
  });
});
