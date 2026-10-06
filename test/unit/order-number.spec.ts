import {
  FIRST_ORDER_NUMBER,
  allocateOrderNumber,
  generateReferenceId,
  isReferenceId,
} from '../../src/orders/order-number';

describe('generateReferenceId', () => {
  it('is always 12 digits with no leading zero', () => {
    for (let index = 0; index < 500; index += 1) {
      const reference = generateReferenceId();
      expect(reference).toMatch(/^[1-9][0-9]{11}$/);
      expect(reference).toHaveLength(12);
    }
  });

  it('does not repeat across a large sample', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      seen.add(generateReferenceId());
    }
    expect(seen.size).toBe(2000);
  });

  it('recognises its own output and rejects anything else', () => {
    expect(isReferenceId(generateReferenceId())).toBe(true);
    expect(isReferenceId('012345678901')).toBe(false); // leading zero
    expect(isReferenceId('12345678901')).toBe(false); // 11 digits
    expect(isReferenceId('1234567890123')).toBe(false); // 13 digits
    expect(isReferenceId('ORD-20260101-ABC1234')).toBe(false);
    expect(isReferenceId('')).toBe(false);
  });
});

describe('allocateOrderNumber', () => {
  it('starts a branch that has never ordered at 1000000', async () => {
    expect(FIRST_ORDER_NUMBER).toBe(1000000);

    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ allocated: 1000000 }]) };

    await expect(allocateOrderNumber(tx as never, 'branch-1')).resolves.toBe('1000000');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns the number the database allocated, as a string', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ allocated: 1000042 }]) };

    await expect(allocateOrderNumber(tx as never, 'branch-1')).resolves.toBe('1000042');
  });

  it('throws rather than inventing a number if the statement returns nothing', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(allocateOrderNumber(tx as never, 'branch-1')).rejects.toThrow(
      /Could not allocate an order number/,
    );
  });
});
