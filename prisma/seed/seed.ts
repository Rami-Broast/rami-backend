/**
 * Database seed.
 *
 * Two parts:
 *
 *  1. REFERENCE DATA (always seeded, every environment) — the canonical roles
 *     and permissions the authorization system depends on. Idempotent, so it is
 *     safe to re-run after adding a permission.
 *
 *  2. DEMO DATA (development only) — a branch and a small menu so the API can
 *     be exercised locally. Refuses to run outside development.
 *
 * This script never creates a user, sets a password, or writes a credential of
 * any kind. Staff accounts are provisioned through the Phase 4 admin flow so
 * that no shared or default login can ever reach a deployed environment.
 */

import { PrismaClient } from '@prisma/client';

import { PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from './permissions';

const prisma = new PrismaClient();

/* eslint-disable no-console -- a CLI script reports to stdout by design */

async function seedPermissions(): Promise<void> {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { code },
      update: { description },
      create: { code, description },
    });
  }

  console.log(`  permissions: ${Object.keys(PERMISSIONS).length}`);
}

async function seedRoles(): Promise<void> {
  for (const name of Object.values(SYSTEM_ROLES)) {
    await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name], isSystem: true },
      create: { name, description: ROLE_DESCRIPTIONS[name], isSystem: true },
    });
  }

  console.log(`  roles: ${Object.values(SYSTEM_ROLES).length}`);
}

async function seedRolePermissions(): Promise<void> {
  let granted = 0;

  for (const [roleName, permissionCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });

    const permissions = await prisma.permission.findMany({
      where: { code: { in: permissionCodes } },
      select: { id: true, code: true },
    });

    if (permissions.length !== permissionCodes.length) {
      const found = new Set(permissions.map((permission) => permission.code));
      const missing = permissionCodes.filter((code) => !found.has(code));
      throw new Error(
        `Role ${roleName} references permissions that do not exist: ${missing.join(', ')}`,
      );
    }

    // Revoke first, so removing a permission from the list actually revokes it
    // rather than leaving a stale grant behind.
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: permissions.map((p) => p.id) } },
    });

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
      granted += 1;
    }
  }

  console.log(`  role permissions: ${granted}`);
}

const FEATURE_FLAGS: { key: string; enabled: boolean; description: string }[] = [
  { key: 'online_payment', enabled: true, description: 'Online payment via Tap' },
  { key: 'cash', enabled: true, description: 'Cash on delivery' },
  { key: 'coupons', enabled: true, description: 'Coupon codes' },
  { key: 'loyalty', enabled: false, description: 'Loyalty points program' },
  { key: 'reviews', enabled: false, description: 'Customer reviews' },
  { key: 'scheduled_orders', enabled: false, description: 'Scheduled/future orders' },
  { key: 'live_tracking', enabled: false, description: 'Live driver tracking' },
  { key: 'referral', enabled: false, description: 'Referral program' },
  { key: 'wallet', enabled: false, description: 'Customer wallet' },
  { key: 'banners', enabled: false, description: 'Advertisement banners' },
  { key: 'pickup', enabled: true, description: 'Pickup orders' },
  { key: 'delivery', enabled: true, description: 'Delivery orders' },
];

async function seedFeatureFlags(): Promise<void> {
  for (const flag of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { description: flag.description },
      create: { key: flag.key, enabled: flag.enabled, description: flag.description },
    });
  }

  await prisma.configVersion.upsert({
    where: { singletonKey: 'config' },
    update: {},
    create: { singletonKey: 'config', version: 1 },
  });

  console.log(`  feature flags: ${FEATURE_FLAGS.length}`);
}

async function seedDemoData(): Promise<void> {
  const branch = await prisma.branch.upsert({
    where: { code: 'BR-001' },
    update: {},
    create: {
      code: 'BR-001',
      name: 'Demo Branch',
      addressLine: '1 Example Street',
      city: 'Riyadh',
      settings: {
        create: {
          acceptsDelivery: true,
          acceptsPickup: true,
          deliveryFeeMinor: 1500,
          minOrderMinor: 2500,
          prepTimeMinutes: 25,
        },
      },
    },
  });

  const category = await prisma.category.upsert({
    where: { id: '00000000-0000-7000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-7000-8000-000000000001',
      name: 'Main Dishes',
      sortOrder: 1,
    },
  });

  // Prices are in halalas: 3250 = 32.50 SAR.
  const demoProducts = [
    { sku: 'DEMO-001', name: 'Demo Grilled Chicken', basePriceMinor: 3250 },
    { sku: 'DEMO-002', name: 'Demo Lamb Kabsa', basePriceMinor: 4800 },
    { sku: 'DEMO-003', name: 'Demo Mixed Grill', basePriceMinor: 6500 },
  ];

  for (const [index, definition] of demoProducts.entries()) {
    const product = await prisma.product.upsert({
      where: { sku: definition.sku },
      update: {},
      create: {
        sku: definition.sku,
        name: definition.name,
        basePriceMinor: definition.basePriceMinor,
        categoryId: category.id,
        sortOrder: index,
      },
    });

    await prisma.productAvailability.upsert({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
      update: {},
      create: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
  }

  console.log(`  demo branch: ${branch.code}`);
  console.log(`  demo products: ${demoProducts.length}`);
}

async function main(): Promise<void> {
  const environment = process.env.NODE_ENV ?? 'development';

  console.log(`Seeding reference data (NODE_ENV=${environment})`);
  await seedPermissions();
  await seedRoles();
  await seedRolePermissions();
  await seedFeatureFlags();

  if (environment === 'development') {
    console.log('Seeding demo data');
    await seedDemoData();
  } else {
    console.log('Skipping demo data — development only');
  }

  console.log('Seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
