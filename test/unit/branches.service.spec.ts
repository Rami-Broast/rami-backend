import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BranchStatus, Prisma } from '@prisma/client';

import { BranchesService } from '../../src/branches/branches.service';
import { ActorKind } from '../../src/auth/types/actor';

const SELECT = {
  id: true,
  code: true,
  name: true,
  nameAr: true,
  phone: true,
  addressLine: true,
  district: true,
  city: true,
  latitude: true,
  longitude: true,
  isActive: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const now = new Date('2026-01-01');

const branch = (overrides: Record<string, unknown> = {}) => ({
  id: 'branch-1',
  code: 'BR-001',
  name: 'Demo Branch',
  nameAr: null,
  phone: null,
  addressLine: '1 Example Street',
  district: null,
  city: 'Riyadh',
  latitude: null,
  longitude: null,
  isActive: true,
  status: BranchStatus.ACTIVE,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  ...overrides,
});

const makePrisma = () => ({
  branch: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  branchSetting: {
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  productAvailability: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  branchOpeningHours: { deleteMany: jest.fn() },
  branchHoursOverride: { deleteMany: jest.fn() },
  branchOrderSequence: { deleteMany: jest.fn() },
  userRole: { deleteMany: jest.fn() },
  driver: { updateMany: jest.fn() },
  user: { findFirst: jest.fn() },
  // What decides delete-vs-archive.
  order: { count: jest.fn().mockResolvedValue(0) },
  settlement: { count: jest.fn().mockResolvedValue(0) },
  delivery: { count: jest.fn().mockResolvedValue(0) },
  cashCollection: { count: jest.fn().mockResolvedValue(0) },
  $transaction: jest.fn() as jest.Mock<unknown, [unknown]>,
});

type MockPrisma = ReturnType<typeof makePrisma>;

/**
 * The password checker, stubbed. Only `deleteBranch` uses it; every other
 * method here never reaches it, and a test that had to provide a real argon2
 * hash to exercise `update` would be testing the wrong thing.
 */
function makePasswords(verify: jest.Mock = jest.fn().mockResolvedValue(true)) {
  return { verify, hash: jest.fn() };
}

function createService(prisma: MockPrisma = makePrisma(), passwords = makePasswords()) {
  // ZATCA provisioning is best-effort and irrelevant to these tests; stub it.
  const zatca = { provisionBranchById: jest.fn().mockResolvedValue(undefined) };
  // The audit recorder is best-effort and swallows its own failures; stub it so
  // these tests exercise the branch logic, not the log write.
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new BranchesService(
      prisma as unknown as ConstructorParameters<typeof BranchesService>[0],
      passwords as unknown as ConstructorParameters<typeof BranchesService>[1],
      zatca as unknown as ConstructorParameters<typeof BranchesService>[2],
      audit as unknown as ConstructorParameters<typeof BranchesService>[3],
    ),
    prisma,
    passwords,
  };
}

describe('BranchesService', () => {
  describe('list', () => {
    it('returns non-deleted branches ordered by name', async () => {
      const { service, prisma } = createService();
      const branches = [branch({ name: 'A' }), branch({ name: 'B' })];
      prisma.branch.findMany.mockResolvedValue(branches);

      const result = await service.list();

      expect(result).toEqual(branches);
      expect(prisma.branch.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        select: SELECT,
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findById', () => {
    it('returns a branch when found', async () => {
      const { service, prisma } = createService();
      const b = branch();
      prisma.branch.findFirst.mockResolvedValue(b);

      const result = await service.findById('branch-1');

      expect(result).toEqual(b);
      expect(prisma.branch.findFirst).toHaveBeenCalledWith({
        where: { id: 'branch-1', deletedAt: null },
        select: SELECT,
      });
    });

    it('throws NotFoundException for an unknown id', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a branch with default settings', async () => {
      const { service, prisma } = createService();
      const b = branch();
      prisma.branch.create.mockResolvedValue(b);

      const result = await service.create({
        code: 'BR-001',
        name: 'Demo Branch',
        addressLine: '1 Example Street',
        city: 'Riyadh',
      });

      expect(result).toEqual(b);
      expect(prisma.branch.create).toHaveBeenCalledWith({
        data: {
          code: 'BR-001',
          name: 'Demo Branch',
          nameAr: undefined,
          phone: undefined,
          addressLine: '1 Example Street',
          district: undefined,
          city: 'Riyadh',
          latitude: undefined,
          longitude: undefined,
          status: BranchStatus.ACTIVE,
          isActive: true,
          settings: { create: {} },
        },
        select: SELECT,
      });
    });

    it('throws ConflictException on duplicate code', async () => {
      const { service, prisma } = createService();
      const uniqueViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '0.0.0',
      });
      prisma.branch.create.mockRejectedValue(uniqueViolation);

      await expect(
        service.create({ code: 'BR-001', name: 'Test', addressLine: '1 St', city: 'Riyadh' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('updates provided fields only', async () => {
      const { service, prisma } = createService();
      const b = branch();
      prisma.branch.findFirst.mockResolvedValue(b);
      prisma.branch.update.mockResolvedValue(branch({ name: 'Renamed' }));

      const result = await service.update('branch-1', { name: 'Renamed' });

      expect(result.name).toBe('Renamed');
      expect(prisma.branch.update).toHaveBeenCalledWith({
        where: { id: 'branch-1' },
        data: { name: 'Renamed' },
        select: SELECT,
      });
    });

    it('throws NotFoundException if branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('changeStatus', () => {
    it('sets status and keeps isActive in sync', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(branch());
      prisma.branch.update.mockResolvedValue(
        branch({ status: BranchStatus.TEMPORARILY_CLOSED, isActive: false }),
      );

      const result = await service.changeStatus('branch-1', {
        status: BranchStatus.TEMPORARILY_CLOSED,
      });

      expect(result.status).toBe(BranchStatus.TEMPORARILY_CLOSED);
      expect(prisma.branch.update).toHaveBeenCalledWith({
        where: { id: 'branch-1' },
        data: { status: BranchStatus.TEMPORARILY_CLOSED, isActive: false },
        select: SELECT,
      });
    });

    it('sets isActive to true when status is ACTIVE', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(
        branch({ status: BranchStatus.TEMPORARILY_CLOSED, isActive: false }),
      );
      prisma.branch.update.mockResolvedValue(branch());

      await service.changeStatus('branch-1', { status: BranchStatus.ACTIVE });

      expect(prisma.branch.update).toHaveBeenCalledWith({
        where: { id: 'branch-1' },
        data: { status: BranchStatus.ACTIVE, isActive: true },
        select: SELECT,
      });
    });

    it('throws NotFoundException if branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(
        service.changeStatus('nonexistent', { status: BranchStatus.SUSPENDED }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('duplicate', () => {
    it('copies branch, settings and product availability', async () => {
      const { service, prisma } = createService();

      const sourceSettings = {
        id: 'setting-1',
        branchId: 'branch-1',
        acceptsDelivery: true,
        acceptsPickup: true,
        isAcceptingOrders: true,
        acceptsCashOnDelivery: false,
        autoAcceptOrders: true,
        deliveryRadiusKm: 10,
        deliveryFeeMinor: 1500,
        minOrderMinor: 2500,
        prepTimeMinutes: 25,
        openingHours: null,
        timezone: 'Asia/Riyadh',
        printerModel: 'epson-tm-t20iii',
        printerConnection: 'qz-tray',
        createdAt: now,
        updatedAt: now,
      };

      const source = {
        ...branch(),
        settings: sourceSettings,
        availability: [
          { productId: 'prod-1', isAvailable: true, priceOverrideMinor: null },
          { productId: 'prod-2', isAvailable: false, priceOverrideMinor: 5000 },
        ],
      };

      prisma.branch.findFirst.mockResolvedValue(source);

      const newBranch = branch({ id: 'branch-2', code: 'BR-002', name: 'Copy Branch' });
      const txBranch = {
        create: jest.fn().mockResolvedValue({ id: 'branch-2' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(newBranch),
      };
      const txSettings = { create: jest.fn() };
      const txAvailability = { createMany: jest.fn() };

      prisma.$transaction.mockImplementation((fn) =>
        (
          fn as (tx: {
            branch: typeof txBranch;
            branchSetting: typeof txSettings;
            productAvailability: typeof txAvailability;
          }) => unknown
        )({ branch: txBranch, branchSetting: txSettings, productAvailability: txAvailability }),
      );

      const result = await service.duplicate('branch-1', {
        code: 'BR-002',
        name: 'Copy Branch',
      });

      expect(result).toEqual(newBranch);
      expect(txBranch.create).toHaveBeenCalledWith({
        data: {
          code: 'BR-002',
          name: 'Copy Branch',
          nameAr: null,
          phone: null,
          addressLine: '1 Example Street',
          district: null,
          city: 'Riyadh',
          latitude: null,
          longitude: null,
          status: BranchStatus.TEMPORARILY_CLOSED,
          isActive: false,
        },
        select: { id: true },
      });
      expect(txSettings.create).toHaveBeenCalledWith({
        data: {
          branchId: 'branch-2',
          acceptsDelivery: true,
          acceptsPickup: true,
          isAcceptingOrders: true,
          acceptsCashOnDelivery: false,
          autoAcceptOrders: true,
          deliveryRadiusKm: 10,
          deliveryFeeMinor: 1500,
          minOrderMinor: 2500,
          prepTimeMinutes: 25,
          openingHours: Prisma.JsonNull,
          timezone: 'Asia/Riyadh',
          printerModel: 'epson-tm-t20iii',
          printerConnection: 'qz-tray',
        },
      });
      expect(txAvailability.createMany).toHaveBeenCalledWith({
        data: [
          {
            branchId: 'branch-2',
            productId: 'prod-1',
            isAvailable: true,
            priceOverrideMinor: null,
          },
          {
            branchId: 'branch-2',
            productId: 'prod-2',
            isAvailable: false,
            priceOverrideMinor: 5000,
          },
        ],
      });
    });

    it('creates inactive branch by default (activate = false)', async () => {
      const { service, prisma } = createService();

      prisma.branch.findFirst.mockResolvedValue({
        ...branch(),
        settings: null,
        availability: [],
      });

      const newBranch = branch({
        id: 'branch-2',
        code: 'BR-002',
        status: BranchStatus.TEMPORARILY_CLOSED,
        isActive: false,
      });
      const txBranch = {
        create: jest.fn().mockResolvedValue({ id: 'branch-2' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(newBranch),
      };

      prisma.$transaction.mockImplementation((fn) =>
        (
          fn as (tx: {
            branch: typeof txBranch;
            branchSetting: { create: jest.Mock };
            productAvailability: { createMany: jest.Mock };
          }) => unknown
        )({
          branch: txBranch,
          branchSetting: { create: jest.fn() },
          productAvailability: { createMany: jest.fn() },
        }),
      );

      const result = await service.duplicate('branch-1', { code: 'BR-002', name: 'Copy' });

      expect(result.status).toBe(BranchStatus.TEMPORARILY_CLOSED);
      expect(txBranch.create).toHaveBeenCalledWith({
        data: {
          code: 'BR-002',
          name: 'Copy',
          nameAr: null,
          phone: null,
          addressLine: '1 Example Street',
          district: null,
          city: 'Riyadh',
          latitude: null,
          longitude: null,
          status: BranchStatus.TEMPORARILY_CLOSED,
          isActive: false,
        },
        select: { id: true },
      });
    });

    it('throws NotFoundException if source branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(service.duplicate('nonexistent', { code: 'BR-X', name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException on duplicate code', async () => {
      const { service, prisma } = createService();

      prisma.branch.findFirst.mockResolvedValue({
        ...branch(),
        settings: null,
        availability: [],
      });

      prisma.$transaction.mockImplementation(() => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '0.0.0',
        });
      });

      await expect(service.duplicate('branch-1', { code: 'BR-001', name: 'Dup' })).rejects.toThrow(
        ConflictException,
      );
    });
  });
});

describe('deleteBranch', () => {
  const actor = { kind: ActorKind.Staff, id: 'user-1' } as unknown as Parameters<
    BranchesService['deleteBranch']
  >[0];
  const confirm = { password: 'correct horse', code: 'BR-001' };

  function scene(
    counts: Partial<Record<'order' | 'settlement' | 'delivery' | 'cashCollection', number>> = {},
  ) {
    const prisma = makePrisma();
    prisma.branch.findFirst.mockResolvedValue(branch());
    prisma.user.findFirst.mockResolvedValue({ passwordHash: 'argon2-hash' });
    prisma.branch.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(branch(data)),
    );
    // The transaction body runs against the same mock client.
    prisma.$transaction.mockImplementation((fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : undefined,
    );
    for (const [model, count] of Object.entries(counts)) {
      (prisma as unknown as Record<string, { count: jest.Mock }>)[model].count.mockResolvedValue(
        count,
      );
    }
    return prisma;
  }

  it('really deletes a branch that has never traded', async () => {
    // The case this exists for: a branch created by mistake in the wizard.
    // Leaving mistakes lying around archived is its own mess.
    const prisma = scene();
    const { service } = createService(prisma);

    const result = await service.deleteBranch(actor, 'branch-1', confirm);

    expect(result.outcome).toBe('DELETED');
    expect(prisma.branch.delete).toHaveBeenCalledWith({ where: { id: 'branch-1' } });
    expect(prisma.branch.update).not.toHaveBeenCalled();
  });

  it('archives a branch that has taken orders, and never deletes it', async () => {
    // A branch owns the orders, settlements and VAT history the restaurant's
    // books are reconstructed from. Deleting it would destroy money records.
    const prisma = scene({ order: 42 });
    const { service } = createService(prisma);

    const result = await service.deleteBranch(actor, 'branch-1', confirm);

    expect(result.outcome).toBe('ARCHIVED');
    expect(prisma.branch.delete).not.toHaveBeenCalled();
    const [update] = prisma.branch.update.mock.calls as unknown as [
      [{ data: { status: BranchStatus; isActive: boolean; deletedAt: Date } }],
    ];
    expect(update[0].data.status).toBe(BranchStatus.ARCHIVED);
    expect(update[0].data.isActive).toBe(false);
    expect(update[0].data.deletedAt).toBeInstanceOf(Date);
    // The caller is told why, because "deleted" and "archived" are different
    // promises and a UI that reports the wrong one is lying to an owner.
    expect(result.reason).toMatch(/42 orders/);
  });

  it.each([
    ['a settlement', { settlement: 1 }],
    ['a delivery', { delivery: 1 }],
    ['a cash collection', { cashCollection: 1 }],
  ])('archives rather than deletes when it has %s', async (_label, counts) => {
    const prisma = scene(counts);
    const { service } = createService(prisma);

    expect((await service.deleteBranch(actor, 'branch-1', confirm)).outcome).toBe('ARCHIVED');
    expect(prisma.branch.delete).not.toHaveBeenCalled();
  });

  it('refuses a wrong password and touches nothing', async () => {
    const prisma = scene();
    const passwords = makePasswords(jest.fn().mockResolvedValue(false));
    const { service } = createService(prisma, passwords);

    await expect(service.deleteBranch(actor, 'branch-1', confirm)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.branch.delete).not.toHaveBeenCalled();
    expect(prisma.branch.update).not.toHaveBeenCalled();
  });

  it('refuses when the typed code is another branch', async () => {
    // The proof that they meant *this* branch. A dialog cannot supply it.
    const prisma = scene();
    const { service, passwords } = createService(prisma);

    await expect(
      service.deleteBranch(actor, 'branch-1', { ...confirm, code: 'BR-002' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Refused before the password is even checked, so a wrong code cannot be
    // used to probe passwords.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(prisma.branch.delete).not.toHaveBeenCalled();
  });

  it('accepts the code in any case', async () => {
    const prisma = scene();
    const { service } = createService(prisma);

    await expect(
      service.deleteBranch(actor, 'branch-1', { ...confirm, code: 'br-001' }),
    ).resolves.toMatchObject({ outcome: 'DELETED' });
  });
});
