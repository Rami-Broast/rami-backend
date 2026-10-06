import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { PasswordService } from '../../src/auth/services/password.service';
import { AuthTestContext, createAuthTestApp, uniquePhone } from './helpers/auth-app';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface Variant {
  id: string;
  name: string;
  priceMinor: number;
  isDefault: boolean;
  isActive: boolean;
}

interface Addon {
  id: string;
  name: string;
  priceMinor: number;
  isActive: boolean;
}

interface ModifierGroup {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  isRequired: boolean;
  addons: Addon[];
}

interface ProductDetail {
  id: string;
  variants: Variant[];
  modifierGroups: { sortOrder: number; modifierGroup: ModifierGroup }[];
}

/**
 * Exercises the Phase-5 catalog write surface: product variants, reusable
 * modifier groups + add-ons, and attaching groups to products. The decisive
 * checks are that `menu:write` (owner-only) gates every mutation, that the
 * single-default-variant invariant holds, and that deletes are soft and
 * detach cleanly.
 */
describe('Menu variants and modifiers (e2e)', () => {
  let context: AuthTestContext;
  let prisma: PrismaClient;
  let http: () => ReturnType<typeof request>;

  let categoryId: string;
  let productId: string;
  let ownerTokens: Tokens;
  let branchAdminTokens: Tokens;
  let customerTokens: Tokens;

  const PASSWORD = 'a-sufficiently-long-password';
  const auth = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` });

  beforeAll(async () => {
    context = await createAuthTestApp();
    prisma = context.prisma;
    http = () => request(context.app.getHttpServer());

    const passwords = new PasswordService();
    const suffix = randomUUID().slice(0, 8);

    const branch = await prisma.branch.create({
      data: { code: `BR-${suffix}`, name: 'Branch', addressLine: '1 St', city: 'Riyadh' },
    });

    const category = await prisma.category.create({ data: { name: `Mains ${suffix}` } });
    categoryId = category.id;

    const product = await prisma.product.create({
      data: { categoryId, name: `Chicken ${suffix}`, sku: `SKU-${suffix}`, basePriceMinor: 11_500 },
    });
    productId = product.id;

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

    // The branch admin gets read + availability, deliberately NOT menu:write.
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
        fullName: 'Branch Admin',
        passwordHash,
        roles: { create: { roleId: branchAdminRole.id, branchId: branch.id } },
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

  const getProduct = async (): Promise<ProductDetail> => {
    const response = await http()
      .get(`/api/v1/menu/products/${productId}`)
      .set(auth(ownerTokens))
      .expect(200);
    return response.body as ProductDetail;
  };

  describe('permissions', () => {
    it('refuses a branch admin the write surface', async () => {
      await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(branchAdminTokens))
        .send({ name: 'Large', priceMinor: 4500 })
        .expect(403);
    });

    it('refuses a customer entirely', async () => {
      await http().get('/api/v1/menu/modifier-groups').set(auth(customerTokens)).expect(403);
    });
  });

  describe('variants', () => {
    it('lets an owner add a variant that shows up on the product', async () => {
      const created = await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(ownerTokens))
        .send({ name: 'Small', priceMinor: 9000, isDefault: true })
        .expect(201);

      const variant = created.body as Variant;
      expect(variant.priceMinor).toBe(9000);
      expect(variant.isDefault).toBe(true);

      const product = await getProduct();
      expect(product.variants.map((v) => v.id)).toContain(variant.id);
    });

    it('keeps at most one default: a new default clears the previous one', async () => {
      const large = await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(ownerTokens))
        .send({ name: 'Large', priceMinor: 13_000, isDefault: true })
        .expect(201);

      const product = await getProduct();
      const defaults = product.variants.filter((v) => v.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe((large.body as Variant).id);
    });

    it('rejects a duplicate variant SKU', async () => {
      const sku = `V-${randomUUID().slice(0, 8)}`;
      await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(ownerTokens))
        .send({ name: 'A', priceMinor: 1000, sku })
        .expect(201);
      await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(ownerTokens))
        .send({ name: 'B', priceMinor: 1000, sku })
        .expect(400);
    });

    it('updates then soft-deletes a variant, removing it from the product', async () => {
      const created = await http()
        .post(`/api/v1/menu/products/${productId}/variants`)
        .set(auth(ownerTokens))
        .send({ name: 'Temp', priceMinor: 5000 })
        .expect(201);
      const id = (created.body as Variant).id;

      await http()
        .patch(`/api/v1/menu/variants/${id}`)
        .set(auth(ownerTokens))
        .send({ priceMinor: 5500 })
        .expect(200);

      await http().delete(`/api/v1/menu/variants/${id}`).set(auth(ownerTokens)).expect(204);

      const product = await getProduct();
      expect(product.variants.map((v) => v.id)).not.toContain(id);
    });

    it('404s updating a variant that does not exist', async () => {
      await http()
        .patch(`/api/v1/menu/variants/${randomUUID()}`)
        .set(auth(ownerTokens))
        .send({ priceMinor: 1 })
        .expect(404);
    });
  });

  describe('modifier groups and add-ons', () => {
    let groupId: string;
    let addonId: string;

    it('creates a group and lists it', async () => {
      const created = await http()
        .post('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .send({ name: 'Sauces', minSelections: 0, maxSelections: 2 })
        .expect(201);
      groupId = (created.body as ModifierGroup).id;

      const list = await http()
        .get('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .expect(200);
      expect((list.body as ModifierGroup[]).map((g) => g.id)).toContain(groupId);
    });

    it('rejects minSelections greater than maxSelections', async () => {
      await http()
        .post('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .send({ name: 'Bad', minSelections: 3, maxSelections: 1 })
        .expect(400);
    });

    it('adds an add-on to the group', async () => {
      const created = await http()
        .post(`/api/v1/menu/modifier-groups/${groupId}/addons`)
        .set(auth(ownerTokens))
        .send({ name: 'Garlic', priceMinor: 300 })
        .expect(201);
      addonId = (created.body as Addon).id;

      const list = await http()
        .get('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .expect(200);
      const group = (list.body as ModifierGroup[]).find((g) => g.id === groupId);
      expect(group?.addons.map((a) => a.id)).toContain(addonId);
    });

    it('attaches the group to the product (idempotently) and detaches it', async () => {
      await http()
        .post(`/api/v1/menu/products/${productId}/modifier-groups`)
        .set(auth(ownerTokens))
        .send({ modifierGroupId: groupId, sortOrder: 1 })
        .expect(201);

      // Re-attach updates rather than erroring.
      await http()
        .post(`/api/v1/menu/products/${productId}/modifier-groups`)
        .set(auth(ownerTokens))
        .send({ modifierGroupId: groupId, sortOrder: 2 })
        .expect(201);

      let product = await getProduct();
      const attached = product.modifierGroups.find((g) => g.modifierGroup.id === groupId);
      expect(attached).toBeDefined();
      expect(attached?.modifierGroup.addons.some((a) => a.id === addonId)).toBe(true);

      await http()
        .delete(`/api/v1/menu/products/${productId}/modifier-groups/${groupId}`)
        .set(auth(ownerTokens))
        .expect(204);

      product = await getProduct();
      expect(product.modifierGroups.map((g) => g.modifierGroup.id)).not.toContain(groupId);
    });

    it('soft-deletes an add-on so it drops out of the group', async () => {
      await http().delete(`/api/v1/menu/addons/${addonId}`).set(auth(ownerTokens)).expect(204);

      const list = await http()
        .get('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .expect(200);
      const group = (list.body as ModifierGroup[]).find((g) => g.id === groupId);
      expect(group?.addons.map((a) => a.id)).not.toContain(addonId);
    });

    it('deleting a group detaches it from products and hides it from the list', async () => {
      // Attach afresh, then delete the group and confirm both effects.
      await http()
        .post(`/api/v1/menu/products/${productId}/modifier-groups`)
        .set(auth(ownerTokens))
        .send({ modifierGroupId: groupId })
        .expect(201);

      await http()
        .delete(`/api/v1/menu/modifier-groups/${groupId}`)
        .set(auth(ownerTokens))
        .expect(204);

      const product = await getProduct();
      expect(product.modifierGroups.map((g) => g.modifierGroup.id)).not.toContain(groupId);

      const list = await http()
        .get('/api/v1/menu/modifier-groups')
        .set(auth(ownerTokens))
        .expect(200);
      expect((list.body as ModifierGroup[]).map((g) => g.id)).not.toContain(groupId);
    });
  });
});
