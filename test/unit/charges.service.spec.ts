import { NotFoundException } from '@nestjs/common';
import { ChargeAppliesTo, ChargeType, OrderType, TaxClass } from '@prisma/client';

import { ChargesService } from '../../src/charges/charges.service';
import { PrismaService } from '../../src/prisma/prisma.service';

function mockPrisma(): { charge: Record<string, jest.Mock> } {
  return {
    charge: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

function chargeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'charge-1',
    name: 'Service Fee',
    nameAr: null,
    type: ChargeType.FIXED,
    appliesTo: ChargeAppliesTo.SUBTOTAL,
    amountMinor: 500,
    percentBps: null,
    taxable: true,
    taxClass: TaxClass.STANDARD,
    branchIds: null,
    conditions: null,
    priority: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ChargesService', () => {
  let service: ChargesService;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new ChargesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('returns all charges ordered by priority then name', async () => {
      const rows = [chargeRow({ id: 'c-1' }), chargeRow({ id: 'c-2' })];
      prisma.charge.findMany.mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toBe(rows);
      expect(prisma.charge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ priority: 'asc' }, { name: 'asc' }],
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns a charge by ID', async () => {
      const row = chargeRow();
      prisma.charge.findUnique.mockResolvedValue(row);

      const result = await service.findById('charge-1');

      expect(result).toBe(row);
      expect(prisma.charge.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'charge-1' } }),
      );
    });

    it('throws NotFoundException when not found', async () => {
      prisma.charge.findUnique.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a charge from DTO', async () => {
      const row = chargeRow();
      prisma.charge.create.mockResolvedValue(row);

      const result = await service.create({
        name: 'Service Fee',
        type: ChargeType.FIXED,
        amountMinor: 500,
      });

      expect(result).toBe(row);
      const call = prisma.charge.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.name).toBe('Service Fee');
      expect(arg.data.type).toBe(ChargeType.FIXED);
      expect(arg.data.amountMinor).toBe(500);
    });

    it('converts date strings to Date objects', async () => {
      prisma.charge.create.mockResolvedValue(chargeRow());

      await service.create({
        name: 'Promo Fee',
        type: ChargeType.FIXED,
        amountMinor: 100,
        startsAt: '2026-07-01T00:00:00Z',
        endsAt: '2026-08-01T00:00:00Z',
      });

      const call = prisma.charge.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.startsAt).toEqual(new Date('2026-07-01T00:00:00Z'));
      expect(arg.data.endsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });
  });

  describe('update', () => {
    it('updates only the provided fields', async () => {
      prisma.charge.findUnique.mockResolvedValue(chargeRow());
      prisma.charge.update.mockResolvedValue(chargeRow({ name: 'Updated' }));

      await service.update('charge-1', { name: 'Updated' });

      const call = prisma.charge.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.name).toBe('Updated');
      expect(arg.data.type).toBeUndefined();
    });

    it('throws NotFoundException when charge does not exist', async () => {
      prisma.charge.findUnique.mockResolvedValue(null);

      await expect(service.update('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('sets startsAt to null when empty string provided', async () => {
      prisma.charge.findUnique.mockResolvedValue(chargeRow());
      prisma.charge.update.mockResolvedValue(chargeRow());

      await service.update('charge-1', { startsAt: '' });

      const call = prisma.charge.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.startsAt).toBeNull();
    });
  });

  describe('resolveForOrder', () => {
    it('evaluates active charges against the context', async () => {
      prisma.charge.findMany.mockResolvedValue([
        chargeRow({ id: 'c-1', amountMinor: 200, priority: 1 }),
        chargeRow({ id: 'c-2', amountMinor: 300, priority: 2 }),
      ]);

      const result = await service.resolveForOrder({
        branchId: 'branch-1',
        subtotalMinor: 10_000,
        deliveryFeeMinor: 500,
        itemCount: 3,
        orderType: OrderType.DELIVERY,
        at: new Date(),
      });

      expect(result).toHaveLength(2);
      expect(result[0].chargeId).toBe('c-1');
      expect(result[0].amountMinor).toBe(200);
      expect(result[1].chargeId).toBe('c-2');
      expect(result[1].amountMinor).toBe(300);
    });

    it('filters inactive charges from the result', async () => {
      prisma.charge.findMany.mockResolvedValue([
        chargeRow({ id: 'c-1', isActive: true }),
        chargeRow({ id: 'c-2', isActive: false }),
      ]);

      const result = await service.resolveForOrder({
        branchId: 'branch-1',
        subtotalMinor: 10_000,
        deliveryFeeMinor: 500,
        itemCount: 1,
        orderType: OrderType.DELIVERY,
        at: new Date(),
      });

      expect(result).toHaveLength(1);
      expect(result[0].chargeId).toBe('c-1');
    });

    it('returns empty array when no charges exist', async () => {
      prisma.charge.findMany.mockResolvedValue([]);

      const result = await service.resolveForOrder({
        branchId: 'branch-1',
        subtotalMinor: 10_000,
        deliveryFeeMinor: 0,
        itemCount: 1,
        orderType: OrderType.PICKUP,
        at: new Date(),
      });

      expect(result).toEqual([]);
    });
  });
});
