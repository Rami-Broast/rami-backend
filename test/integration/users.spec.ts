import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { AuthModule } from '../../src/auth/auth.module';
import { PasswordService } from '../../src/auth/services/password.service';
import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { createBranch, unique } from './helpers/factories';

/**
 * Users (staff administration) against a real database.
 *
 * Focuses on the defensive invariants — no duplicate emails, no
 * self-deactivation, no lockout of the last OWNER, password reset revokes live
 * sessions — because the happy-path CRUD is straightforward and covered by
 * typecheck. The idea is that a regression to one of these invariants would
 * silently open the door to real damage (locked-out organisation, an attacker
 * outliving a password reset), so it needs a test that would catch it.
 */
describe('UsersService (integration)', () => {
  const prisma = new PrismaClient();
  let users: UsersService;
  let passwords: PasswordService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AuthModule, UsersModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    users = app.get(UsersService);
    passwords = app.get(PasswordService);
    close = () => app.close();

    // Seeded system roles must exist; the seed lives outside the test harness,
    // so upsert them here to keep this suite self-contained.
    for (const name of ['OWNER', 'BRANCH_ADMIN', 'DRIVER', 'KITCHEN']) {
      await prisma.role.upsert({ where: { name }, update: {}, create: { name, isSystem: true } });
    }
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  function ownerActor(id: string): Actor {
    return {
      kind: ActorKind.Staff,
      id,
      email: 'owner@test',
      fullName: 'Test Owner',
      roles: ['OWNER'],
      permissions: new Set(['users:read', 'users:write', 'roles:assign']),
      branchScope: { kind: 'NONE' },
    };
  }

  async function seedOwner(): Promise<string> {
    const owner = await prisma.user.create({
      data: {
        email: `${unique('owner')}@test`,
        fullName: 'Seed Owner',
        passwordHash: await passwords.hash('a-long-enough-seed-password'),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: role.id } });
    return owner.id;
  }

  it('creates a staff user and, when a role is supplied, grants it in the same transaction', async () => {
    const branch = await createBranch(prisma);
    const created = await users.create({
      email: `${unique('admin')}@test`,
      password: 'a-strong-enough-pw',
      fullName: 'Branch Admin',
      role: 'BRANCH_ADMIN',
      branchId: branch.id,
    });

    expect(created.roles).toHaveLength(1);
    expect(created.roles[0]?.role.name).toBe('BRANCH_ADMIN');
    expect(created.roles[0]?.branch?.id).toBe(branch.id);
    // The hash never leaves the service, even when nested inside a role grant.
    expect(Object.keys(created)).not.toContain('passwordHash');
  });

  it('rejects a duplicate email at the DB uniqueness boundary rather than trusting a read-then-write', async () => {
    const email = `${unique('dup')}@test`;
    await users.create({
      email,
      password: 'a-strong-enough-pw',
      fullName: 'Original',
    });

    await expect(
      users.create({
        email: email.toUpperCase(),
        password: 'a-strong-enough-pw',
        fullName: 'Impostor',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to deactivate the OWNER performing the request', async () => {
    const ownerId = await seedOwner();

    await expect(
      users.update(ownerActor(ownerId), ownerId, { isActive: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to deactivate the only active OWNER, no matter who asks', async () => {
    // A second owner is the caller so the self-check does not fire; but if
    // they were to deactivate the ONLY other active owner (which happens to
    // be themselves after being demoted — irrelevant here) the org would be
    // locked out, so the check must still hold.
    //
    // Concretely: seed exactly one active OWNER, deactivate them from
    // another actor that happens to also be OWNER-eligible but is created
    // as a separate user; the check counts OWNERs OTHER than the target, so
    // deactivating the last one is refused.
    // (Every prior test may have added owners; scope this test's assertion
    // to a fresh DB slice by counting owners we control.)

    // Deactivate every existing active OWNER first so the target is truly last.
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    await prisma.user.updateMany({
      where: {
        isActive: true,
        deletedAt: null,
        roles: { some: { roleId: ownerRole.id } },
      },
      data: { isActive: false },
    });

    // Now create the one active OWNER left, plus a second staff caller who
    // is NOT an OWNER (permissions don't matter here — the service checks
    // its own DB count, not the actor).
    const soleOwnerId = await seedOwner();
    const caller = await prisma.user.create({
      data: {
        email: `${unique('caller')}@test`,
        fullName: 'Caller',
        passwordHash: await passwords.hash('a-long-enough-caller-pw'),
      },
    });

    await expect(
      users.update(ownerActor(caller.id), soleOwnerId, { isActive: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('password reset revokes every live refresh-token session for the target user', async () => {
    const target = await prisma.user.create({
      data: {
        email: `${unique('pwreset')}@test`,
        fullName: 'Reset Target',
        passwordHash: await passwords.hash('an-original-strong-pw'),
      },
    });
    // Two live sessions — different families — to prove the revoke sweeps
    // both, not just one row.
    await prisma.refreshToken.createMany({
      data: [
        {
          tokenHash: `hash-a-${target.id}`,
          familyId: `fam-a-${target.id}`,
          userId: target.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          tokenHash: `hash-b-${target.id}`,
          familyId: `fam-b-${target.id}`,
          userId: target.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const anyActor = ownerActor(target.id);
    await users.resetPassword(anyActor, target.id, { password: 'a-brand-new-strong-pw' });

    const live = await prisma.refreshToken.count({
      where: { userId: target.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });
});
