import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { ActorService } from '../../src/auth/services/actor.service';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { branchScopeFilter } from '../../src/branches/branch-scope';
import { createBranch, unique } from './helpers/factories';

/**
 * Branch scope is derived from role grants in the database, so this is where
 * Phase 5's central rule is actually proved: an owner reaches everything, a
 * branch admin reaches exactly their assignments, and anyone else reaches
 * nothing.
 */
describe('Actor resolution and branch scope (integration)', () => {
  const prisma = new PrismaClient();
  let actors: ActorService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
      providers: [ActorService],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    actors = app.get(ActorService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  const createStaff = async () =>
    prisma.user.create({
      data: {
        email: `${unique('staff')}@example.test`,
        fullName: 'Test Staff',
        passwordHash: 'not-a-real-hash',
      },
    });

  const roleNamed = async (name: string) =>
    prisma.role.upsert({ where: { name }, update: {}, create: { name, isSystem: true } });

  describe('owner', () => {
    it('reaches every branch through an unscoped OWNER grant', async () => {
      const user = await createStaff();
      const owner = await roleNamed('OWNER');
      await prisma.userRole.create({
        data: { userId: user.id, roleId: owner.id, branchId: null },
      });

      const actor = await actors.resolveStaff(user.id);

      expect(actor.roles).toContain('OWNER');
      expect(actor.branchScope).toEqual({ kind: 'ALL' });
      // An unrestricted query filter is correct here, and only here.
      expect(branchScopeFilter(actor)).toEqual({});
    });
  });

  describe('branch admin', () => {
    it('reaches exactly the branches granted', async () => {
      const [branchA, branchB] = await Promise.all([createBranch(prisma), createBranch(prisma)]);
      const user = await createStaff();
      const role = await roleNamed('BRANCH_ADMIN');

      await prisma.userRole.createMany({
        data: [
          { userId: user.id, roleId: role.id, branchId: branchA.id },
          { userId: user.id, roleId: role.id, branchId: branchB.id },
        ],
      });

      const actor = await actors.resolveStaff(user.id);

      expect(actor.branchScope.kind).toBe('ASSIGNED');
      expect(
        actor.branchScope.kind === 'ASSIGNED' ? [...actor.branchScope.branchIds].sort() : [],
      ).toEqual([branchA.id, branchB.id].sort());
    });

    it('loses reach the moment a branch assignment is revoked', async () => {
      const [branchA, branchB] = await Promise.all([createBranch(prisma), createBranch(prisma)]);
      const user = await createStaff();
      const role = await roleNamed('BRANCH_ADMIN');

      await prisma.userRole.createMany({
        data: [
          { userId: user.id, roleId: role.id, branchId: branchA.id },
          { userId: user.id, roleId: role.id, branchId: branchB.id },
        ],
      });

      await prisma.userRole.deleteMany({ where: { userId: user.id, branchId: branchB.id } });

      const actor = await actors.resolveStaff(user.id);

      // Resolved per request, so revocation is immediate rather than waiting
      // for a token to expire.
      expect(actor.branchScope).toEqual({ kind: 'ASSIGNED', branchIds: [branchA.id] });
    });

    it('does not gain organisation-wide reach from a non-OWNER unscoped grant', async () => {
      const user = await createStaff();
      const role = await roleNamed('BRANCH_ADMIN');

      // A provisioning mistake: a branch role granted with no branch. This must
      // not be read as "every branch".
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, branchId: null },
      });

      const actor = await actors.resolveStaff(user.id);

      expect(actor.branchScope).toEqual({ kind: 'NONE' });
      expect(branchScopeFilter(actor)).toEqual({ branchId: { in: [] } });
    });
  });

  describe('permissions', () => {
    it('collects permission codes from the granted roles', async () => {
      const branch = await createBranch(prisma);
      const user = await createStaff();
      const role = await roleNamed('BRANCH_ADMIN');

      const permission = await prisma.permission.upsert({
        where: { code: 'orders:read' },
        update: {},
        create: { code: 'orders:read', description: 'View orders' },
      });

      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });

      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, branchId: branch.id },
      });

      const actor = await actors.resolveStaff(user.id);

      expect(actor.permissions.has('orders:read')).toBe(true);
    });

    it('gives a user with no roles no permissions and no branches', async () => {
      const user = await createStaff();

      const actor = await actors.resolveStaff(user.id);

      expect(actor.permissions.size).toBe(0);
      expect(actor.branchScope).toEqual({ kind: 'NONE' });
    });
  });

  describe('account state', () => {
    it('refuses a deactivated user', async () => {
      const user = await createStaff();
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      await expect(actors.resolveStaff(user.id)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a soft-deleted user', async () => {
      const user = await createStaff();
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

      await expect(actors.resolveStaff(user.id)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses an unknown id exactly as it refuses a disabled one', async () => {
      await expect(
        actors.resolveStaff('00000000-0000-7000-8000-00000000dead'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('customers', () => {
    it('resolves with no permissions and no branch reach', async () => {
      const customer = await prisma.customer.create({
        data: { phone: `+9665${Math.floor(10_000_000 + Math.random() * 89_999_999)}` },
      });

      const actor = await actors.resolveCustomer(customer.id);

      expect(actor.permissions.size).toBe(0);
      expect(actor.branchScope).toEqual({ kind: 'NONE' });
      expect(branchScopeFilter(actor)).toEqual({ branchId: { in: [] } });
    });
  });
});
