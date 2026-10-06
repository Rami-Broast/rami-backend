import { ActorType } from '@prisma/client';

import { actorToFields, sanitizeSnapshot } from '../../src/audit/audit-entry';
import { ActorKind, type Actor } from '../../src/auth/types/actor';

/**
 * The pure side of the audit recorder: mapping an actor to its columns, and
 * producing a JSON-safe, credential-free snapshot. Both run on every audit row,
 * and both fail *silently* if wrong — a leaked hash in an append-only table
 * cannot be taken back out, and a mis-attributed action is worse than none.
 */
describe('actorToFields', () => {
  const staff: Actor = {
    kind: ActorKind.Staff,
    id: 'user-1',
    email: 'owner@test',
    fullName: 'Owner',
    roles: ['OWNER'],
    permissions: new Set(),
    branchScope: { kind: 'ALL' },
  };

  const customer: Actor = {
    kind: ActorKind.Customer,
    id: 'cust-1',
    phone: '+966500000000',
    permissions: new Set(),
    branchScope: { kind: 'NONE' },
  };

  it('maps a staff actor to USER with the user id', () => {
    expect(actorToFields(staff)).toEqual({
      actorType: ActorType.USER,
      actorUserId: 'user-1',
      actorCustomerId: null,
    });
  });

  it('maps a customer actor to CUSTOMER with the customer id', () => {
    expect(actorToFields(customer)).toEqual({
      actorType: ActorType.CUSTOMER,
      actorUserId: null,
      actorCustomerId: 'cust-1',
    });
  });

  it('attributes an absent actor to the system rather than dropping it', () => {
    expect(actorToFields(undefined)).toEqual({
      actorType: ActorType.SYSTEM,
      actorUserId: null,
      actorCustomerId: null,
    });
  });

  it('uses the caller-supplied fallback flavour of non-person', () => {
    expect(actorToFields(undefined, ActorType.GATEWAY).actorType).toBe(ActorType.GATEWAY);
  });
});

describe('sanitizeSnapshot', () => {
  it('masks sensitive keys at any depth, case-insensitively', () => {
    const out = sanitizeSnapshot({
      email: 'a@b.c',
      password: 'hunter2',
      passwordHash: '$argon2id$...',
      nested: { Token: 'abc', refreshToken: 'def', ok: 1 },
    }) as Record<string, unknown>;

    expect(out.email).toBe('a@b.c');
    expect(out.password).toBe('[REDACTED]');
    expect(out.passwordHash).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.Token).toBe('[REDACTED]');
    expect(nested.refreshToken).toBe('[REDACTED]');
    expect(nested.ok).toBe(1);
  });

  it('leaves undefined absent and preserves an explicit null', () => {
    expect(sanitizeSnapshot(undefined)).toBeUndefined();
    expect(sanitizeSnapshot(null)).toBeNull();
  });

  it('renders a Date as an ISO string', () => {
    expect(sanitizeSnapshot(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('stringifies BigInt (JSON cannot encode it)', () => {
    expect(sanitizeSnapshot(10n)).toBe('10');
  });

  it('serialises a Decimal-like object via its own string form, not its internals', () => {
    // Stands in for Prisma.Decimal: a non-plain object whose useful value is its
    // toString(), and which must never be walked field by field.
    class FakeDecimal {
      constructor(private readonly raw: string) {}
      toString(): string {
        return this.raw;
      }
    }
    expect(sanitizeSnapshot({ radius: new FakeDecimal('24.72') })).toEqual({ radius: '24.72' });
  });

  it('walks arrays', () => {
    expect(sanitizeSnapshot([{ password: 'x' }, 2])).toEqual([{ password: '[REDACTED]' }, 2]);
  });

  it('truncates pathologically deep structures rather than looping', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i += 1) {
      const next: Record<string, unknown> = {};
      deep.child = next;
      deep = next;
    }
    // Should return without throwing, and cap the depth with a marker somewhere.
    expect(() => JSON.stringify(sanitizeSnapshot(root))).not.toThrow();
    expect(JSON.stringify(sanitizeSnapshot(root))).toContain('[TRUNCATED]');
  });
});
