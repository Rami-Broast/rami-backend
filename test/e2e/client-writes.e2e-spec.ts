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

interface Identified {
  id: string;
}

/**
 * Every write a client app performs, with the body that app actually builds.
 *
 * The read side is covered by `client-contracts.e2e-spec.ts`. This is the other
 * half, and it fails in two ways the read side cannot:
 *
 *   1. **A field the DTO does not declare.** `forbidNonWhitelisted` rejects the
 *      whole request, so a form that sends one extra key is a Save button that
 *      never works. That is not hypothetical — the admin app's new-product form
 *      sent `isActive`, which `CreateProductDto` did not accept.
 *   2. **A write that does not stick, or quietly erases something.** So every
 *      create is read back and every partial update asserts that the fields it
 *      did *not* send are unchanged. A PATCH that blanks a neighbouring column
 *      is worse than one that 400s, because nothing reports it.
 *
 * Bodies here are copied from the apps' API clients and forms. When a form
 * starts sending a new field, add it here in the same commit.
 */
describe('Client write contracts (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let http: () => ReturnType<typeof request>;

  let branchId: string;
  let categoryId: string;
  let owner: Tokens;
  let branchAdmin: Tokens;
  let customer: Tokens;

  const PASSWORD = 'a-sufficiently-long-password';
  let suffix: string;

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    http = () => request(context.app.getHttpServer());

    const passwords = new PasswordService();
    suffix = randomUUID().slice(0, 8);

    const branch = await prisma.branch.create({
      data: {
        code: `CW-${suffix}`,
        name: 'Writes Branch',
        addressLine: '1 Writes Street',
        city: 'Riyadh',
        settings: { create: { acceptsPickup: true, acceptsDelivery: true } },
      },
    });
    branchId = branch.id;

    const category = await prisma.category.create({ data: { name: `CW Cat ${suffix}` } });
    categoryId = category.id;

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
    // DRIVER is seeded too, even though nothing signs in as one here: the
    // driver test creates a user *with* that role, and relying on another
    // suite having created it first makes this file pass only on a database
    // something else has already touched.
    for (const roleName of [SYSTEM_ROLES.OWNER, SYSTEM_ROLES.BRANCH_ADMIN, SYSTEM_ROLES.DRIVER]) {
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
        email: `cw-owner-${suffix}@example.test`,
        fullName: 'Writes Owner',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.OWNER)!, branchId: null } },
      },
    });
    const branchUser = await prisma.user.create({
      data: {
        email: `cw-branch-${suffix}@example.test`,
        fullName: 'Writes Branch Admin',
        passwordHash,
        roles: { create: { roleId: roleIds.get(SYSTEM_ROLES.BRANCH_ADMIN)!, branchId } },
      },
    });

    owner = await staffLogin(ownerUser.email);
    branchAdmin = await staffLogin(branchUser.email);
    customer = await customerLogin();
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
   * Performs one write and fails with the server's own message.
   *
   * A rejected field is reported by the pipe as a field-level message, so
   * surfacing the body turns "a Save button does nothing" into a named field.
   */
  async function writes<T = Identified>(
    as: Tokens,
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const req = http()[method](`/api/v1${path}`).set(auth(as));
    const response = await (body === undefined ? req : req.send(body as object));

    if (response.status >= 400) {
      throw new Error(
        `${method.toUpperCase()} ${path} -> ${response.status}\n${JSON.stringify(response.body)}`,
      );
    }
    return response.body as T;
  }

  /** `as: null` reads a public route the way a signed-out customer app does. */
  async function reads<T>(as: Tokens | null, path: string): Promise<T> {
    const request = http().get(`/api/v1${path}`);
    const response = await (as ? request.set(auth(as)) : request);
    if (response.status >= 400) {
      throw new Error(`GET ${path} -> ${response.status}\n${JSON.stringify(response.body)}`);
    }
    return response.body as T;
  }

  // ===========================================================================
  // Menu — the largest write surface in the admin app
  // ===========================================================================

  describe('menu', () => {
    it('creates a category, edits it, and the edit keeps what it did not touch', async () => {
      const created = await writes<{ id: string; name: string; nameAr: string | null }>(
        owner,
        'post',
        '/menu/categories',
        // Exactly what CategoryForm sends.
        { name: `Cat ${suffix}`, nameAr: 'قسم', description: 'A category' },
      );
      expect(created.id).toBeTruthy();

      const updated = await writes<{ name: string; nameAr: string | null }>(
        owner,
        'patch',
        `/menu/categories/${created.id}`,
        { name: `Cat ${suffix} edited` },
      );

      expect(updated.name).toBe(`Cat ${suffix} edited`);
      // The Arabic name was not in the patch and must survive it.
      expect(updated.nameAr).toBe('قسم');
    });

    it('creates a product with every field the form sends, including isActive', async () => {
      // The new-product form offers an active toggle, so a product can be
      // prepared as a draft. Creating one has to accept that field.
      const created = await writes<{ id: string; isActive: boolean; sku: string | null }>(
        owner,
        'post',
        '/menu/products',
        {
          categoryId,
          name: `Product ${suffix}`,
          nameAr: 'منتج',
          description: 'A product',
          sku: `SKU-${suffix}`,
          basePriceMinor: 11_500,
          taxClass: 'STANDARD',
          isActive: false,
          imageUrl: 'https://example.test/p.png',
        },
      );

      expect(created.isActive).toBe(false);

      // And it is genuinely stored, not just echoed.
      const readBack = await reads<{ isActive: boolean; sku: string | null }>(
        owner,
        `/menu/products/${created.id}`,
      );
      expect(readBack.isActive).toBe(false);
      expect(readBack.sku).toBe(`SKU-${suffix}`);
    });

    it('edits a product without erasing the fields the patch omits', async () => {
      const created = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Keep ${suffix}`,
        nameAr: 'يبقى',
        sku: `KEEP-${suffix}`,
        basePriceMinor: 5000,
        taxClass: 'STANDARD',
        isActive: true,
      });

      await writes(owner, 'patch', `/menu/products/${created.id}`, { basePriceMinor: 6000 });

      const after = await reads<{
        basePriceMinor: number;
        nameAr: string | null;
        sku: string | null;
        isActive: boolean;
      }>(owner, `/menu/products/${created.id}`);

      expect(after.basePriceMinor).toBe(6000);
      expect(after.nameAr).toBe('يبقى');
      expect(after.sku).toBe(`KEEP-${suffix}`);
      expect(after.isActive).toBe(true);
    });

    it('creates and edits variants, modifier groups and add-ons', async () => {
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `WithOptions ${suffix}`,
        sku: `OPT-${suffix}`,
        basePriceMinor: 9000,
        taxClass: 'STANDARD',
        isActive: true,
      });

      const variant = await writes<Identified>(
        owner,
        'post',
        `/menu/products/${product.id}/variants`,
        { name: 'Large', nameAr: 'كبير', priceMinor: 12_000, isDefault: true },
      );
      await writes(owner, 'patch', `/menu/variants/${variant.id}`, { isDefault: true });
      await writes(owner, 'patch', `/menu/variants/${variant.id}`, { isActive: true });
      await writes(owner, 'patch', `/menu/variants/${variant.id}`, {
        name: 'Extra Large',
        priceMinor: 13_000,
      });

      const group = await writes<Identified>(owner, 'post', '/menu/modifier-groups', {
        name: `Extras ${suffix}`,
        nameAr: 'إضافات',
        minSelections: 0,
        maxSelections: 3,
        isRequired: false,
      });
      await writes(owner, 'patch', `/menu/modifier-groups/${group.id}`, {
        name: `Extras ${suffix} v2`,
        maxSelections: 4,
      });

      const addon = await writes<Identified>(
        owner,
        'post',
        `/menu/modifier-groups/${group.id}/addons`,
        { name: 'Garlic', nameAr: 'ثوم', priceMinor: 500, taxClass: 'STANDARD' },
      );
      await writes(owner, 'patch', `/menu/addons/${addon.id}`, {
        name: 'Extra garlic',
        priceMinor: 700,
      });

      await writes(owner, 'post', `/menu/products/${product.id}/modifier-groups`, {
        modifierGroupId: group.id,
        sortOrder: 0,
      });

      // The whole structure is readable back through the product detail.
      const detail = await reads<{
        variants: { name: string }[];
        modifierGroups: unknown[];
      }>(owner, `/menu/products/${product.id}`);
      expect(detail.variants.some((v) => v.name === 'Extra Large')).toBe(true);
      expect(detail.modifierGroups.length).toBeGreaterThan(0);

      await writes(owner, 'delete', `/menu/products/${product.id}/modifier-groups/${group.id}`);
    });

    it('sets branch availability with a price override and clears it again', async () => {
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Avail ${suffix}`,
        sku: `AV-${suffix}`,
        basePriceMinor: 7000,
        taxClass: 'STANDARD',
        isActive: true,
      });

      await writes(
        branchAdmin,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        {
          isAvailable: true,
          priceOverrideMinor: 8000,
        },
      );
      await writes(
        branchAdmin,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        {
          isAvailable: false,
          priceOverrideMinor: null,
        },
      );

      const list = await reads<{ productId: string; isAvailable: boolean }[]>(
        branchAdmin,
        `/menu/branches/${branchId}/availability`,
      );
      expect(list.some((row) => row.productId === product.id && !row.isAvailable)).toBe(true);
    });

    it('soft-deletes a product without taking its category with it', async () => {
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Doomed ${suffix}`,
        sku: `DOOM-${suffix}`,
        basePriceMinor: 1000,
        taxClass: 'STANDARD',
        isActive: true,
      });

      await writes(owner, 'delete', `/menu/products/${product.id}`);

      // The category — and everything else in it — is untouched.
      const category = await reads<Identified>(owner, `/menu/categories`);
      expect(category).toBeTruthy();
      const products = await reads<{ id: string }[]>(owner, '/menu/products?includeInactive=true');
      expect(products.some((p) => p.id === product.id)).toBe(false);
    });
  });

  // ===========================================================================
  // Branches
  // ===========================================================================

  describe('branches', () => {
    it('creates a branch, edits it, and the edit keeps the untouched fields', async () => {
      const created = await writes<Identified & { nameAr: string | null; phone: string | null }>(
        owner,
        'post',
        '/branches',
        {
          code: `NEW-${suffix.toUpperCase()}`,
          name: 'New Branch',
          nameAr: 'فرع جديد',
          phone: '+966500000001',
          addressLine: '9 New Street',
          district: 'Olaya',
          city: 'Riyadh',
          latitude: 24.7136,
          longitude: 46.6753,
        },
      );

      await writes(owner, 'patch', `/branches/${created.id}`, { name: 'Renamed Branch' });

      const after = await reads<{ name: string; nameAr: string | null; city: string }>(
        owner,
        `/branches/${created.id}`,
      );
      expect(after.name).toBe('Renamed Branch');
      expect(after.nameAr).toBe('فرع جديد');
      expect(after.city).toBe('Riyadh');
    });

    it('saves branch settings one toggle at a time without resetting the others', async () => {
      const before = await reads<Record<string, unknown>>(owner, `/branches/${branchId}/settings`);

      await writes(owner, 'patch', `/branches/${branchId}/settings`, { prepTimeMinutes: 35 });
      await writes(owner, 'patch', `/branches/${branchId}/settings`, { autoAcceptOrders: false });

      const after = await reads<Record<string, unknown>>(owner, `/branches/${branchId}/settings`);
      expect(after.prepTimeMinutes).toBe(35);
      expect(after.autoAcceptOrders).toBe(false);
      // A settings patch must not reset the neighbouring flags.
      expect(after.acceptsDelivery).toBe(before.acceptsDelivery);
      expect(after.acceptsPickup).toBe(before.acceptsPickup);

      await writes(owner, 'patch', `/branches/${branchId}/settings`, { autoAcceptOrders: true });
    });

    it('saves opening hours and an override', async () => {
      const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        openMinute: 600,
        closeMinute: 1380,
        isClosed: false,
      }));

      await writes(owner, 'put', `/branches/${branchId}/hours`, { hours });

      const saved = await reads<{ hours: { dayOfWeek: number; openMinute: number }[] }>(
        owner,
        `/branches/${branchId}/hours`,
      );
      expect(saved.hours).toHaveLength(7);
      expect(saved.hours[0].openMinute).toBe(600);

      await writes(owner, 'post', `/branches/${branchId}/hours/overrides`, {
        date: '2030-01-01',
        isClosed: true,
        note: 'Public holiday',
      });
    });

    it('changes branch status and duplicates a branch', async () => {
      const source = await writes<Identified>(owner, 'post', '/branches', {
        code: `SRC-${suffix.toUpperCase()}`,
        name: 'Source Branch',
        addressLine: '3 Source Street',
        city: 'Riyadh',
      });

      // The admin app's own status values. TEMPORARILY_CLOSED is the closed
      // state — there is no 'CLOSED' or 'PAUSED' in the enum.
      await writes(owner, 'post', `/branches/${source.id}/status`, {
        status: 'TEMPORARILY_CLOSED',
        reason: 'Refurbishment',
      });

      const paused = await reads<{ status: string }>(owner, `/branches/${source.id}`);
      expect(paused.status).toBe('TEMPORARILY_CLOSED');

      // A closed branch can still be archived — the admin app gates that button
      // on this exact status, so a mismatch here strands the branch.
      await writes(owner, 'post', `/branches/${source.id}/status`, { status: 'ARCHIVED' });

      const copy = await writes<Identified>(owner, 'post', `/branches/${source.id}/duplicate`, {
        code: `COPY-${suffix.toUpperCase()}`,
        name: 'Copied Branch',
        activate: false,
      });

      // Duplicating must not disturb the branch it copied from.
      const original = await reads<{ status: string; name: string }>(
        owner,
        `/branches/${source.id}`,
      );
      expect(original.name).toBe('Source Branch');
      expect(original.status).toBe('ARCHIVED');
      expect(copy.id).not.toBe(source.id);
    });
  });

  // ===========================================================================
  // Growth: charges, coupons, banners, homepage, feature flags, loyalty
  // ===========================================================================

  describe('the customer docket template', () => {
    const template = {
      sections: ['brand', 'orderType', 'orderMeta', 'items', 'totals', 'thankYou'],
      printLogoImage: true,
      logoImageUrl: null,
      logoWidthPercent: 100,
      logoLines: [],
      brandLines: ['Rami Broast'],
      showBranchName: true,
      showNewCustomerBadge: true,
      readyTimeRules: {
        largeOrderThresholdMinor: 10000,
        smallOrderMinutes: [10, 15],
        largeOrderMinutes: [20, 25],
        deliveryExtraMinutes: 5,
      },
      thankYouLines: ['Thank you!'],
      footerLines: ['Not a tax invoice'],
    };

    it("saves the owner's template and serves it back", async () => {
      await writes(owner, 'put', '/receipt-templates/default', template);

      const after = await reads<{ template: { thankYouLines: string[] } }>(
        owner,
        '/receipt-templates/default',
      );
      expect(after.template.thankYouLines).toEqual(['Thank you!']);
    });

    it("puts a branch's override on top, and takes it off again", async () => {
      await writes(owner, 'put', '/receipt-templates/default', template);
      await writes(owner, 'put', `/receipt-templates/branches/${branchId}`, {
        thankYouLines: ['See you in Olaya'],
      });

      const overridden = await reads<{
        resolved: { thankYouLines: string[]; brandLines: string[] };
      }>(owner, `/receipt-templates/branches/${branchId}`);
      expect(overridden.resolved.thankYouLines).toEqual(['See you in Olaya']);
      // And the fields it may not set are still the owner's.
      expect(overridden.resolved.brandLines).toEqual(['Rami Broast']);

      await writes(owner, 'delete', `/receipt-templates/branches/${branchId}`);
      const cleared = await reads<{ resolved: { thankYouLines: string[] } }>(
        owner,
        `/receipt-templates/branches/${branchId}`,
      );
      expect(cleared.resolved.thankYouLines).toEqual(['Thank you!']);
    });

    it("refuses a branch override that reaches for the owner's layout", async () => {
      // `forbidNonWhitelisted` is what makes this a refusal rather than a
      // silent drop, and the refusal is the point: a branch that believes it
      // has changed the footer, and has not, prints the wrong receipt for a
      // month before anybody reads one.
      const response = await http()
        .put(`/api/v1/receipt-templates/branches/${branchId}`)
        .set(auth(owner))
        .send({ footerLines: ['A tax invoice'], sections: ['items'] });

      expect(response.status).toBe(400);
    });
  });

  describe('growth and config', () => {
    it('creates and edits a charge', async () => {
      const created = await writes<Identified & { name: string; isActive: boolean }>(
        owner,
        'post',
        '/charges',
        {
          name: `Service ${suffix}`,
          nameAr: 'خدمة',
          type: 'PERCENTAGE',
          appliesTo: 'SUBTOTAL',
          percentBps: 500,
          taxable: true,
          taxClass: 'STANDARD',
          priority: 1,
          isActive: true,
          // Scoped to this run's own branch. An active charge with no
          // `branchIds` applies to **every** order in the database, including
          // ones other suites create later — this fixture used to leave one
          // behind and 17 pricing assertions in the integration suite failed
          // afterwards, looking exactly like a pricing regression.
          branchIds: [branchId],
        },
      );

      await writes(owner, 'patch', `/charges/${created.id}`, { priority: 2 });

      const after = await reads<{ name: string; percentBps: number; priority: number }>(
        owner,
        `/charges/${created.id}`,
      );
      expect(after.priority).toBe(2);
      expect(after.name).toBe(`Service ${suffix}`);
      expect(after.percentBps).toBe(500);
    });

    it('creates a coupon with rules', async () => {
      const created = await writes<Identified & { code: string }>(owner, 'post', '/coupons', {
        code: `SAVE${suffix.toUpperCase()}`,
        name: 'Ten off',
        description: 'Ten percent off',
        discountType: 'PERCENTAGE',
        discountValue: '10',
        maxDiscountMinor: 5000,
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
        totalUsageLimit: 100,
        perCustomerLimit: 1,
        rules: [{ ruleType: 'MIN_SPEND', config: { minSpendMinor: 5000 } }],
      });

      const after = await reads<{ code: string }>(owner, `/coupons/${created.id}`);
      expect(after.code).toBe(`SAVE${suffix.toUpperCase()}`);
    });

    it('creates and publishes a promotion, with the body the admin form sends', async () => {
      // A promotion is an *automatic* discount: no code, no per-customer limit,
      // and it applies to every qualifying cart the moment it is published. The
      // two empty arrays below are the ones that matter — the admin form sends
      // them explicitly, and on the server empty means "every branch" and "the
      // whole basket" rather than "none".
      const created = await writes<Identified & { isActive: boolean }>(
        owner,
        'post',
        '/promotions',
        {
          name: `Weekend ${suffix}`,
          nameAr: 'عرض نهاية الأسبوع',
          description: 'Ten percent off this weekend',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          maxDiscountMinor: 3000,
          branchIds: [],
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2030-01-01T23:59:59.999Z',
          priority: 0,
          productIds: [],
        },
      );

      // Created as a draft. A promotion that started discounting the moment it
      // was created would give money away between typing and reviewing.
      expect(created.isActive).toBe(false);

      const published = await writes<{ isActive: boolean }>(
        owner,
        'post',
        `/promotions/${created.id}/publish`,
        {},
      );
      expect(published.isActive).toBe(true);

      // It reaches the customer app through the same public bootstrap, carrying
      // `branchIds` so the app can drop one this customer's branch does not run.
      const config = await reads<{
        promotions: { id: string; name: string; branchIds: string[] }[];
      }>(null, '/customer/config');
      const listed = config.promotions.find((p) => p.id === created.id);
      expect(listed?.name).toBe(`Weekend ${suffix}`);
      expect(listed?.branchIds).toEqual([]);

      // A partial edit leaves every field it did not send alone.
      await writes(owner, 'patch', `/promotions/${created.id}`, { priority: 3 });
      const after = await reads<{ priority: number; name: string; discountValue: string }>(
        owner,
        `/promotions/${created.id}`,
      );
      expect(after.priority).toBe(3);
      expect(after.name).toBe(`Weekend ${suffix}`);
      expect(Number(after.discountValue)).toBe(10);

      // Pausing takes it off the customer app without deleting anything.
      await writes(owner, 'post', `/promotions/${created.id}/unpublish`, {});
      const configAfter = await reads<{ promotions: { id: string }[] }>(null, '/customer/config');
      expect(configAfter.promotions.map((p) => p.id)).not.toContain(created.id);

      // And it must not be left discounting every branch's orders for the rest
      // of this suite.
      await writes(owner, 'delete', `/promotions/${created.id}`, undefined);
    });

    it('creates an offer — a coupon published to the app with its artwork', async () => {
      const code = `OFFER${suffix.toUpperCase()}`;
      const created = await writes<Identified>(owner, 'post', '/coupons', {
        code,
        name: 'Twenty off',
        description: 'Twenty percent off your order',
        discountType: 'PERCENTAGE',
        discountValue: '20',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
        isPublic: true,
        imageUrl: 'https://example.test/offers/twenty.jpg',
      });

      // It reaches the customer app through the same public bootstrap the home
      // screen already loads, carrying the code the checkout will accept.
      const config = await reads<{ offers: { code: string; imageUrl?: string }[] }>(
        null,
        '/customer/config',
      );
      const offer = config.offers.find((o) => o.code === code);
      expect(offer?.imageUrl).toBe('https://example.test/offers/twenty.jpg');

      // Unpublishing takes it off the page and leaves the terms alone.
      await writes(owner, 'patch', `/coupons/${created.id}`, { isPublic: false });
      const afterPatch = await reads<{ isPublic: boolean; discountValue: string; code: string }>(
        owner,
        `/coupons/${created.id}`,
      );
      expect(afterPatch.isPublic).toBe(false);
      expect(afterPatch.code).toBe(code);
      expect(Number(afterPatch.discountValue)).toBe(20);

      const configAfter = await reads<{ offers: { code: string }[] }>(null, '/customer/config');
      expect(configAfter.offers.map((o) => o.code)).not.toContain(code);
    });

    /**
     * The upload → save round trip, which is the flow the admin's `ImageField`
     * actually performs on the Menu, Coupons and Banners pages.
     *
     * It was broken on two of those three: `POST /assets` returns a relative
     * `/assets/<id>` path, and the coupon and banner DTOs validated `imageUrl`
     * with `@IsUrl()`, which rejects it. So an owner could upload artwork and
     * then be told "imageUrl must be a URL address" about a value this backend
     * had just handed them — and a banner, whose `imageUrl` is required, could
     * not be created at all.
     *
     * Asserting the DTO in isolation would not have caught it. The bug only
     * exists in the join between two endpoints, so the test has to cross it.
     */
    it('saves an uploaded image on a product, a coupon and a banner', async () => {
      // A 1x1 PNG — the smallest thing the type allow-list accepts.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );

      const uploaded = await http()
        .post('/api/v1/assets')
        .set(auth(owner))
        .attach('file', png, { filename: 'art.png', contentType: 'image/png' })
        .expect(201);

      const { url } = uploaded.body as { url: string };
      expect(url).toMatch(/^\/assets\//);

      // The image must be *embeddable* by the clients, not just fetchable. Every
      // app renders it with an <img> pointed at this API from its own, different
      // origin; helmet's default `Cross-Origin-Resource-Policy: same-origin`
      // makes the browser block exactly that — the image loads then vanishes and
      // every uploaded photo is invisible on every client while a direct visit
      // still works. The serve route sets `cross-origin` to allow the embed, and
      // this asserts it so the header cannot silently regress. (CORS is a
      // separate mechanism that governs the JSON API, which is why fetch() calls
      // kept working while images did not.)
      const served = await http().get(`/api/v1${url}`).expect(200);
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(served.headers['content-type']).toBe('image/png');

      // Every image-bearing create must accept the value the upload returned.
      await writes(owner, 'post', '/menu/products', {
        categoryId,
        name: `Uploaded image product ${suffix}`,
        basePriceMinor: 1500,
        imageUrl: url,
      });

      const coupon = await writes<Identified>(owner, 'post', '/coupons', {
        code: `ART${suffix.toUpperCase()}`,
        name: 'Artwork offer',
        discountType: 'PERCENTAGE',
        discountValue: '5',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
        isPublic: true,
        imageUrl: url,
      });

      const banner = await writes<Identified>(owner, 'post', '/banners', {
        name: `Uploaded banner ${suffix}`,
        imageUrl: url,
        title: 'Now serving',
      });

      // And re-imaging an existing record must accept it too — the PATCH path
      // carried the same validator.
      await writes(owner, 'patch', `/coupons/${coupon.id}`, { imageUrl: url });
      await writes(owner, 'patch', `/banners/${banner.id}`, { imageUrl: url });

      const savedCoupon = await reads<{ imageUrl: string }>(owner, `/coupons/${coupon.id}`);
      expect(savedCoupon.imageUrl).toBe(url);

      // An absolute URL still works: artwork referenced before uploads existed
      // must keep loading.
      await writes(owner, 'patch', `/coupons/${coupon.id}`, {
        imageUrl: 'https://cdn.example.test/legacy.png',
      });

      // A scheme that would execute in an <img src> is still refused — this is
      // an allow-list, not a loosening to "any string".
      await http()
        .patch(`/api/v1/coupons/${coupon.id}`)
        .set(auth(owner))
        .send({ imageUrl: 'javascript:alert(1)' })
        .expect(400);
    });

    it('creates, publishes, edits and deletes a banner', async () => {
      const created = await writes<Identified>(owner, 'post', '/banners', {
        name: `Banner ${suffix}`,
        imageUrl: 'https://example.test/banner.png',
        title: 'Welcome',
        titleAr: 'أهلاً',
        description: 'A banner',
        action: 'NONE',
        priority: 1,
      });

      await writes(owner, 'post', `/banners/${created.id}/publish`);
      await writes(owner, 'patch', `/banners/${created.id}`, { title: 'Welcome back' });

      const after = await reads<{ title: string; titleAr: string | null }>(
        owner,
        `/banners/${created.id}`,
      );
      expect(after.title).toBe('Welcome back');
      expect(after.titleAr).toBe('أهلاً');

      await writes(owner, 'post', `/banners/${created.id}/unpublish`);
      await writes(owner, 'delete', `/banners/${created.id}`);
    });

    it('upserts and reorders homepage sections', async () => {
      const section = await writes<Identified>(owner, 'put', '/homepage/sections', {
        kind: 'BANNERS',
        title: 'Offers',
        titleAr: 'العروض',
        position: 0,
        enabled: true,
      });

      // Upsert again with the same kind: this must update, never duplicate.
      await writes(owner, 'put', '/homepage/sections', {
        kind: 'BANNERS',
        title: 'Offers and deals',
        position: 1,
        enabled: true,
      });

      const sections = await reads<{ id: string; kind: string; title: string }[]>(
        owner,
        '/homepage/sections',
      );
      expect(sections.filter((s) => s.kind === 'BANNERS')).toHaveLength(1);

      await writes(owner, 'post', '/homepage/sections/reorder', {
        sectionIds: sections.map((s) => s.id),
      });
      expect(section.id).toBeTruthy();
    });

    it('toggles a feature flag', async () => {
      const flags = await reads<{ key: string; enabled: boolean }[]>(owner, '/feature-flags');
      if (flags.length === 0) {
        return;
      }
      const flag = flags[0];
      await writes(owner, 'patch', `/feature-flags/${flag.key}`, { enabled: !flag.enabled });
      await writes(owner, 'patch', `/feature-flags/${flag.key}`, { enabled: flag.enabled });
    });

    it('adjusts a customer’s loyalty and the ledger keeps both entries', async () => {
      const me = await reads<Identified>(customer, '/customer/me');

      await writes(owner, 'post', '/loyalty/adjust', {
        customerId: me.id,
        points: 50,
        reason: 'Goodwill',
      });
      await writes(owner, 'post', '/loyalty/adjust', {
        customerId: me.id,
        points: -20,
        reason: 'Correction',
      });

      const ledger = await reads<{ balance: number; data: unknown[] }>(
        owner,
        `/loyalty/${me.id}?limit=50`,
      );
      // The ledger is append-only: the second adjustment must not replace the first.
      expect(ledger.balance).toBe(30);
      expect(ledger.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // People
  // ===========================================================================

  describe('people', () => {
    it('creates a staff user, edits the name, and deactivates without deleting', async () => {
      const created = await writes<Identified & { email: string }>(owner, 'post', '/users', {
        email: `made-${suffix}@example.test`,
        password: PASSWORD,
        fullName: 'Made User',
        role: SYSTEM_ROLES.BRANCH_ADMIN,
        branchId,
      });

      await writes(owner, 'patch', `/users/${created.id}`, { fullName: 'Renamed User' });
      await writes(owner, 'patch', `/users/${created.id}`, { isActive: false });

      const after = await reads<{ fullName: string; isActive: boolean; email: string }>(
        owner,
        `/users/${created.id}`,
      );
      expect(after.fullName).toBe('Renamed User');
      expect(after.isActive).toBe(false);
      // Deactivating is not deleting — the account and its email remain.
      expect(after.email).toBe(`made-${suffix}@example.test`);

      await writes(owner, 'post', `/users/${created.id}/reset-password`, {
        password: 'another-sufficiently-long-password',
      });
    });

    it('creates a driver and edits the vehicle without losing the licence', async () => {
      const user = await writes<Identified>(owner, 'post', '/users', {
        email: `driver-${suffix}@example.test`,
        password: PASSWORD,
        fullName: 'Made Driver',
        role: SYSTEM_ROLES.DRIVER,
        branchId,
      });

      const created = await writes<Identified>(owner, 'post', '/drivers', {
        userId: user.id,
        vehicleType: 'CAR',
        licenseNumber: 'LIC-1',
        vehiclePlate: 'ABC 123',
      });

      await writes(owner, 'patch', `/drivers/${created.id}`, { vehiclePlate: 'XYZ 789' });

      const after = await reads<{ vehiclePlate: string | null; licenseNumber: string | null }>(
        owner,
        `/drivers/${created.id}`,
      );
      expect(after.vehiclePlate).toBe('XYZ 789');
      expect(after.licenseNumber).toBe('LIC-1');
    });
  });

  // ===========================================================================
  // Customer app writes
  // ===========================================================================

  describe('customer app', () => {
    it('adds addresses, edits one, and the others survive', async () => {
      const first = await writes<Identified>(customer, 'post', '/customer/addresses', {
        label: 'Home',
        line1: '1 First Street',
        city: 'Riyadh',
        district: 'Olaya',
        notes: 'Second floor',
        isDefault: true,
      });
      const second = await writes<Identified>(customer, 'post', '/customer/addresses', {
        label: 'Work',
        line1: '2 Second Street',
        city: 'Riyadh',
      });

      await writes(customer, 'patch', `/customer/addresses/${second.id}`, { label: 'Office' });

      const list = await reads<{ id: string; label: string | null; line1: string }[]>(
        customer,
        '/customer/addresses',
      );
      expect(list.find((a) => a.id === second.id)?.label).toBe('Office');
      // Editing one address must not disturb another.
      expect(list.find((a) => a.id === first.id)?.line1).toBe('1 First Street');

      await writes(customer, 'delete', `/customer/addresses/${second.id}`);
      const afterDelete = await reads<{ id: string }[]>(customer, '/customer/addresses');
      expect(afterDelete.some((a) => a.id === first.id)).toBe(true);
      expect(afterDelete.some((a) => a.id === second.id)).toBe(false);
    });

    it('updates the profile name and leaves the phone alone', async () => {
      const before = await reads<{ phone: string }>(customer, '/customer/me');

      await writes(customer, 'patch', '/customer/me', { fullName: 'Renamed Customer' });

      const after = await reads<{ fullName: string | null; phone: string }>(
        customer,
        '/customer/me',
      );
      expect(after.fullName).toBe('Renamed Customer');
      expect(after.phone).toBe(before.phone);
    });

    /**
     * Apple rejects an app that creates accounts and cannot delete them
     * (Guideline 5.1.1(v)), and the Account screen's Delete flow is the only
     * thing standing between this app and that rejection. It signs in its own
     * throwaway customer rather than using the suite's, because the whole point
     * of the call is that the account stops working afterwards.
     */
    it('deletes an account, and the session stops working immediately', async () => {
      const doomed = await customerLogin();
      const before = await reads<{ id: string; phone: string }>(doomed, '/customer/me');
      await writes(doomed, 'post', '/customer/addresses', {
        line1: '9 Ninth Street',
        city: 'Riyadh',
      });

      await writes(doomed, 'delete', '/customer/me');

      // The access token is still cryptographically valid; the actor behind it
      // is not, and that is what has to refuse.
      await http().get('/api/v1/customer/me').set(auth(doomed)).expect(401);

      const row = await prisma.customer.findUniqueOrThrow({ where: { id: before.id } });
      expect(row.fullName).toBeNull();
      expect(row.email).toBeNull();
      expect(row.deletedAt).not.toBeNull();
      expect(row.phone).not.toBe(before.phone);

      // The number is released, so the same person can come back as a new
      // customer — deleting an account is not a permanent ban.
      await http()
        .post('/api/v1/auth/customer/otp/request')
        .send({ phone: before.phone })
        .expect(200);
    });
  });

  // ===========================================================================
  // Order lifecycle writes
  // ===========================================================================

  describe('orders', () => {
    async function placeOrder(): Promise<Identified> {
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Orderable ${randomUUID().slice(0, 6)}`,
        sku: `ORD-${randomUUID().slice(0, 8)}`,
        basePriceMinor: 11_500,
        taxClass: 'STANDARD',
        isActive: true,
      });
      await writes(
        owner,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        {
          isAvailable: true,
        },
      );

      return writes<Identified>(branchAdmin, 'post', '/orders', {
        branchId,
        type: 'PICKUP',
        customerPhone: uniquePhone(),
        paymentMethod: 'CASH',
        cashCollected: true,
        items: [{ productId: product.id, quantity: 2 }],
      });
    }

    it('walks an order through the kitchen and each step sticks', async () => {
      const order = await placeOrder();

      await writes(branchAdmin, 'post', `/orders/${order.id}/preparing`);
      expect((await reads<{ status: string }>(branchAdmin, `/orders/${order.id}`)).status).toBe(
        'PREPARING',
      );

      await writes(branchAdmin, 'post', `/orders/${order.id}/ready`);
      await writes(branchAdmin, 'post', `/orders/${order.id}/complete-pickup`);

      const done = await reads<{ status: string; items: unknown[]; referenceId: string }>(
        branchAdmin,
        `/orders/${order.id}`,
      );
      // There is no separate COMPLETED status — a handed-over pickup is
      // DELIVERED, the same terminal state a delivered order reaches.
      expect(done.status).toBe('DELIVERED');
      // The order keeps its items and its reference all the way through.
      expect(done.items).toHaveLength(1);
      expect(done.referenceId).toMatch(/^[1-9][0-9]{11}$/);
    });

    it('cancels an order with a reason, keeping the order and its history', async () => {
      const order = await placeOrder();

      await writes(branchAdmin, 'post', `/orders/${order.id}/cancel`, {
        reason: 'Customer changed their mind',
      });

      const after = await reads<{
        status: string;
        cancellationReason: string | null;
        statusHistory: unknown[];
      }>(branchAdmin, `/orders/${order.id}`);
      expect(after.status).toBe('CANCELLED');
      expect(after.cancellationReason).toBe('Customer changed their mind');
      // Cancelling records history rather than erasing the order.
      expect(after.statusHistory.length).toBeGreaterThan(1);
    });

    it('edits an item quantity and records the edit in an append-only history', async () => {
      const order = await placeOrder();
      const detail = await reads<{ items: { id: string; quantity: number }[] }>(
        branchAdmin,
        `/orders/${order.id}`,
      );
      const item = detail.items[0];

      await writes(branchAdmin, 'patch', `/orders/${order.id}/items/${item.id}`, {
        quantity: 3,
        reason: 'Customer asked for one more',
      });

      const edits = await reads<unknown[]>(branchAdmin, `/orders/${order.id}/edits`);
      expect(edits.length).toBeGreaterThan(0);

      const after = await reads<{ items: { id: string; quantity: number }[] }>(
        branchAdmin,
        `/orders/${order.id}`,
      );
      expect(after.items.find((i) => i.id === item.id)?.quantity).toBe(3);
    });

    it('accepts or rejects on a manual-accept branch', async () => {
      await writes(owner, 'patch', `/branches/${branchId}/settings`, { autoAcceptOrders: false });
      try {
        const toAccept = await placeOrder();
        await writes(branchAdmin, 'post', `/orders/${toAccept.id}/accept`);
        expect(
          (await reads<{ status: string }>(branchAdmin, `/orders/${toAccept.id}`)).status,
        ).toBe('CONFIRMED');

        const toReject = await placeOrder();
        await writes(branchAdmin, 'post', `/orders/${toReject.id}/reject`, {
          reason: 'Kitchen is closing',
        });
        // A rejection is a cancellation carrying the branch's reason — there is
        // no separate REJECTED status in the machine.
        const rejected = await reads<{ status: string; cancellationReason: string | null }>(
          branchAdmin,
          `/orders/${toReject.id}`,
        );
        expect(rejected.status).toBe('CANCELLED');
        expect(rejected.cancellationReason).toContain('Kitchen is closing');
      } finally {
        await writes(owner, 'patch', `/branches/${branchId}/settings`, { autoAcceptOrders: true });
      }
    });
  });

  // ===========================================================================
  // Refund and cancellation requests — customer asks, branch decides
  // ===========================================================================

  describe('refund requests', () => {
    /**
     * Clear the shared branch's opening hours first.
     *
     * The branches block above saves a real schedule on this branch, and
     * **customer** placement enforces opening hours where staff placement
     * deliberately does not — so every order placed here as a customer 400s with
     * "this branch is closed" depending only on what time the suite runs. That
     * asymmetry is intended behaviour (a walk-in at the counter is not refused
     * by a schedule); it just means a customer-facing test cannot inherit
     * another test's trading hours.
     */
    beforeAll(async () => {
      await prisma.branchHoursOverride.deleteMany({ where: { branchId } });
      await prisma.branchOpeningHours.deleteMany({ where: { branchId } });
    });

    /** A cash-on-delivery order the given customer owns, past self-cancel. */
    async function customerOrderInPreparation(as: Tokens): Promise<Identified> {
      await writes(owner, 'patch', `/branches/${branchId}/settings`, {
        acceptsCashOnDelivery: true,
      });
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Refundable ${randomUUID().slice(0, 6)}`,
        sku: `RFQ-${randomUUID().slice(0, 8)}`,
        basePriceMinor: 11_500,
        taxClass: 'STANDARD',
        isActive: true,
      });
      await writes(
        owner,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        { isAvailable: true },
      );

      const order = await writes<Identified>(as, 'post', '/customer/orders', {
        branchId,
        type: 'PICKUP',
        paymentMethod: 'CASH_ON_DELIVERY',
        items: [{ productId: product.id, quantity: 1 }],
      });

      // Past CONFIRMED the order engine no longer lets a customer cancel it
      // themselves, which is the whole reason a request exists.
      await writes(branchAdmin, 'post', `/orders/${order.id}/preparing`);
      return order;
    }

    /**
     * A card order paid for real (through a signed mock webhook) and delivered.
     *
     * The cash path proves the request flow; this one is the only way to reach
     * the part that matters most — money actually captured through a gateway,
     * so approving owes something and the owner's payout has something to move.
     */
    async function paidCardOrder(as: Tokens): Promise<Identified> {
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Card ${randomUUID().slice(0, 6)}`,
        sku: `CRD-${randomUUID().slice(0, 8)}`,
        basePriceMinor: 11_500,
        taxClass: 'STANDARD',
        isActive: true,
      });
      await writes(
        owner,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        { isAvailable: true },
      );

      const order = await writes<Identified>(as, 'post', '/customer/orders', {
        branchId,
        type: 'PICKUP',
        paymentMethod: 'CARD',
        items: [{ productId: product.id, quantity: 1 }],
      });

      await writes(as, 'post', `/customer/orders/${order.id}/pay`, { method: 'CARD' });

      // The gateway's own id is not on any client-facing payload — a customer
      // has no business holding it — so the sandbox completion is driven from
      // the database, exactly as the payments integration tests do.
      const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId: order.id },
        select: { gatewayPaymentId: true },
      });
      await http()
        .post('/api/v1/webhooks/payments/mock/simulate')
        .send({ gatewayPaymentId: payment.gatewayPaymentId, outcome: 'SUCCEEDED' })
        .expect(200);

      await writes(branchAdmin, 'post', `/orders/${order.id}/preparing`);
      await writes(branchAdmin, 'post', `/orders/${order.id}/ready`);
      await writes(branchAdmin, 'post', `/orders/${order.id}/complete-pickup`);

      return order;
    }

    it('offers a self-cancel while the order is early enough for one', async () => {
      const buyer = await customerLogin();
      await writes(owner, 'patch', `/branches/${branchId}/settings`, {
        acceptsCashOnDelivery: true,
      });
      const product = await writes<Identified>(owner, 'post', '/menu/products', {
        categoryId,
        name: `Early ${randomUUID().slice(0, 6)}`,
        sku: `EAR-${randomUUID().slice(0, 8)}`,
        basePriceMinor: 5_000,
        taxClass: 'STANDARD',
        isActive: true,
      });
      await writes(
        owner,
        'patch',
        `/menu/branches/${branchId}/products/${product.id}/availability`,
        { isAvailable: true },
      );
      const order = await writes<Identified>(buyer, 'post', '/customer/orders', {
        branchId,
        type: 'PICKUP',
        paymentMethod: 'CASH_ON_DELIVERY',
        items: [{ productId: product.id, quantity: 1 }],
      });

      const eligibility = await reads<{ canSelfCancel: boolean; canRequest: boolean }>(
        buyer,
        `/customer/orders/${order.id}/refund-eligibility`,
      );
      expect(eligibility.canSelfCancel).toBe(true);
      expect(eligibility.canRequest).toBe(false);

      // The panel's cancel path is the order engine's own endpoint, which this
      // app had shipped an API method for and never called from any screen.
      await writes(buyer, 'post', `/customer/orders/${order.id}/cancel`, {
        reason: 'Changed my mind',
      });
      expect((await reads<{ status: string }>(buyer, `/customer/orders/${order.id}`)).status).toBe(
        'CANCELLED',
      );
    });

    it('raises a request the branch can approve, and the customer sees the decision', async () => {
      const buyer = await customerLogin();
      const order = await customerOrderInPreparation(buyer);

      const eligibility = await reads<{ canRequest: boolean; type: string | null }>(
        buyer,
        `/customer/orders/${order.id}/refund-eligibility`,
      );
      expect(eligibility.canRequest).toBe(true);
      expect(eligibility.type).toBe('CANCELLATION');

      const raised = await writes<Identified & { status: string }>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Ordered from the wrong branch' },
      );
      expect(raised.status).toBe('PENDING');

      // The branch queue the admin Refunds page reads.
      const queue = await reads<{ data: { id: string }[] }>(
        owner,
        `/refund-requests?limit=50&status=PENDING&branchId=${branchId}`,
      );
      expect(queue.data.some((r) => r.id === raised.id)).toBe(true);

      // The **branch** decides — that is the owner's instruction, and the whole
      // reason `refund-requests:decide` exists apart from `refunds:write`.
      const decided = await writes<{
        request: { status: string; orderCancelled: boolean; refundId: string | null };
        outcome: string;
      }>(branchAdmin, 'post', `/refund-requests/${raised.id}/approve`, {
        note: 'Sorry about that.',
        cancelOrder: true,
      });

      // Cash on delivery: nothing was captured, so nothing is refunded — and
      // the outcome says so rather than implying money moved.
      expect(decided.outcome).toBe('CANCELLED_NO_REFUND');
      expect(decided.request.status).toBe('APPROVED');
      expect(decided.request.refundId).toBeNull();
      expect(decided.request.orderCancelled).toBe(true);

      expect((await reads<{ status: string }>(buyer, `/customer/orders/${order.id}`)).status).toBe(
        'CANCELLED',
      );

      // …and the customer can read what was decided, which is the whole point.
      const mine = await reads<{ data: { status: string; resolutionNote: string | null }[] }>(
        buyer,
        `/customer/refund-requests?orderId=${order.id}`,
      );
      expect(mine.data[0]?.status).toBe('APPROVED');
      expect(mine.data[0]?.resolutionNote).toBe('Sorry about that.');
    });

    it('declines with a reason, and refuses to decline without one', async () => {
      const buyer = await customerLogin();
      const order = await customerOrderInPreparation(buyer);
      const raised = await writes<Identified>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Too slow' },
      );

      // The note is required by the DTO. Without this the admin form would send
      // an empty note and get a validation error about a field it never showed.
      await http()
        .post(`/api/v1/refund-requests/${raised.id}/reject`)
        .set(auth(branchAdmin))
        .send({})
        .expect(400);

      const declined = await writes<{ status: string; resolutionNote: string | null }>(
        branchAdmin,
        'post',
        `/refund-requests/${raised.id}/reject`,
        { note: 'The order is already being cooked.' },
      );
      expect(declined.status).toBe('REJECTED');
      expect(declined.resolutionNote).toBe('The order is already being cooked.');
    });

    it('lets a customer withdraw their own request before anyone decides', async () => {
      const buyer = await customerLogin();
      const order = await customerOrderInPreparation(buyer);
      const raised = await writes<Identified>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Actually it is fine' },
      );

      const withdrawn = await writes<{ status: string }>(
        buyer,
        'post',
        `/customer/refund-requests/${raised.id}/withdraw`,
      );
      expect(withdrawn.status).toBe('WITHDRAWN');

      // Withdrawing frees the order for a second ask — one *open* request per
      // order, not one ever.
      const again = await writes<{ status: string }>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Changed my mind again' },
      );
      expect(again.status).toBe('PENDING');
    });

    it('lets the branch decide but never lets it move money', async () => {
      const buyer = await customerLogin();
      const order = await customerOrderInPreparation(buyer);
      const raised = await writes<Identified>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Wrong item' },
      );

      // `refunds:read` — their own queue.
      const queue = await reads<{ data: { id: string }[] }>(
        branchAdmin,
        '/refund-requests?limit=50&status=PENDING',
      );
      expect(queue.data.some((r) => r.id === raised.id)).toBe(true);

      // `refund-requests:decide` — theirs.
      await writes(branchAdmin, 'post', `/refund-requests/${raised.id}/approve`, {});

      // `refunds:write` — the owner's, and the whole point of the split. A
      // branch manager holding this would also hold the direct-refund button on
      // the Payments page, which is exactly what was not wanted.
      await http()
        .post(`/api/v1/refund-requests/${raised.id}/record-refund`)
        .set(auth(branchAdmin))
        .send({ gatewayReference: 'tap_nope' })
        .expect(403);

      await http()
        .post('/api/v1/refunds')
        .set(auth(branchAdmin))
        .send({ paymentId: randomUUID(), reason: 'not mine to issue' })
        .expect(403);
    });

    it('records the owner’s payout, and only then does the order read as refunded', async () => {
      // The card path: approving promises money, the owner sends it in the
      // gateway's dashboard, and recording it here is what moves our columns.
      const buyer = await customerLogin();
      const order = await paidCardOrder(buyer);
      const raised = await writes<Identified>(
        buyer,
        'post',
        `/customer/orders/${order.id}/refund-request`,
        { reason: 'Half of it was missing' },
      );

      const decided = await writes<{
        request: { refundId: string | null; approvedAmountMinor: number | null };
        outcome: string;
      }>(branchAdmin, 'post', `/refund-requests/${raised.id}/approve`, {});

      expect(decided.outcome).toBe('AWAITING_PAYOUT');
      expect(decided.request.refundId).toBeNull();
      expect(decided.request.approvedAmountMinor).toBeGreaterThan(0);

      // Still paid: nothing has gone back, and no screen may say otherwise.
      expect(
        (await reads<{ paymentStatus: string }>(owner, `/orders/${order.id}`)).paymentStatus,
      ).toBe('PAID');

      // The owner's payout queue — approved, money still owed.
      const owing = await reads<{ data: { id: string }[] }>(
        owner,
        '/refund-requests?limit=50&awaitingPayout=true',
      );
      expect(owing.data.some((r) => r.id === raised.id)).toBe(true);

      // The reference is required: a refund recorded with nothing to match it
      // against cannot be tied to a payout line at reconciliation.
      await http()
        .post(`/api/v1/refund-requests/${raised.id}/record-refund`)
        .set(auth(owner))
        .send({})
        .expect(400);

      const recorded = await writes<{ refundId: string | null; refundIssuedAt: string | null }>(
        owner,
        'post',
        `/refund-requests/${raised.id}/record-refund`,
        { gatewayReference: 'tap_ref_e2e', note: 'Refunded in the Tap dashboard' },
      );
      expect(recorded.refundId).not.toBeNull();
      expect(recorded.refundIssuedAt).not.toBeNull();

      expect(
        (await reads<{ paymentStatus: string }>(owner, `/orders/${order.id}`)).paymentStatus,
      ).toBe('REFUNDED');

      // And it shows up as a real refund, marked as one a person issued by hand.
      const refunds = await reads<{
        data: { id: string; issuedManually?: boolean; gatewayReference?: string | null }[];
      }>(owner, `/refunds?limit=25&orderId=${order.id}`);
      expect(refunds.data.some((r) => r.id === recorded.refundId)).toBe(true);

      // It is no longer owed.
      const stillOwing = await reads<{ data: { id: string }[] }>(
        owner,
        '/refund-requests?limit=50&awaitingPayout=true',
      );
      expect(stillOwing.data.some((r) => r.id === raised.id)).toBe(false);
    });
  });
});
