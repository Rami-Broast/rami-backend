import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IdempotencyStatus, PrismaClient } from '@prisma/client';

import { AppConfigModule } from '../../src/config/config.module';
import { IdempotencyModule } from '../../src/common/idempotency/idempotency.module';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { unique } from './helpers/factories';

/**
 * Retry safety for writes.
 *
 * Order placement had none: eight identical concurrent requests created eight
 * real orders, and a mobile client that timed out and retried produced a
 * duplicate the kitchen would cook. The `IdempotencyRecord` table existed the
 * whole time and nothing read or wrote it.
 */
describe('IdempotencyService (integration)', () => {
  const prisma = new PrismaClient();
  let idempotency: IdempotencyService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, IdempotencyModule],
    }).compile();

    const app = await moduleRef.init();
    idempotency = moduleRef.get(IdempotencyService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
    await prisma.$disconnect();
  });

  const scope = 'test.order';

  it('runs the work when no key is sent, exactly as before', async () => {
    // Idempotency is opt-in. A client that sends no key must not be refused.
    let runs = 0;

    await idempotency.run(scope, undefined, { a: 1 }, () => Promise.resolve(++runs));
    await idempotency.run(scope, undefined, { a: 1 }, () => Promise.resolve(++runs));

    expect(runs).toBe(2);
  });

  it('runs once and replays the stored response for a repeated key', async () => {
    const key = unique('key');
    let runs = 0;
    const work = (): Promise<{ orderNumber: string; totalMinor: number }> => {
      runs += 1;
      return Promise.resolve({ orderNumber: '1000001', totalMinor: 22_500 });
    };

    const first = await idempotency.run(scope, key, { a: 1 }, work);
    const second = await idempotency.run(scope, key, { a: 1 }, work);

    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });

  it('lets only one of many concurrent identical requests do the work', async () => {
    // The unique index is the lock. A read-then-write check would let several
    // through, which is the bug this exists to prevent.
    const key = unique('key');
    let runs = 0;

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        idempotency.run(scope, key, { a: 1 }, async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { id: 'once' };
        }),
      ),
    );

    expect(runs).toBe(1);

    // The losers either replay the result or are told it is still running —
    // never a second order.
    for (const failure of results) {
      if (failure.status !== 'rejected') {
        continue;
      }
      expect(failure.reason).toBeInstanceOf(ConflictException);
    }
    for (const success of results) {
      if (success.status === 'fulfilled') {
        expect(success.value).toEqual({ id: 'once' });
      }
    }
  });

  it('refuses the same key sent with a different request', async () => {
    // Otherwise a client that reuses a key answers order B with order A.
    const key = unique('key');
    await idempotency.run(scope, key, { a: 1 }, () => Promise.resolve({ ok: true }));

    await expect(
      idempotency.run(scope, key, { a: 2 }, () => Promise.resolve({ ok: true })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('lets a genuinely failed attempt be retried', async () => {
    // A failure that locked the key for ever would strand the customer.
    const key = unique('key');
    let runs = 0;

    await expect(
      idempotency.run(scope, key, { a: 1 }, () => {
        runs += 1;
        throw new Error('gateway down');
      }),
    ).rejects.toThrow('gateway down');

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope, key } },
    });
    expect(record.status).toBe(IdempotencyStatus.FAILED);

    const retried = await idempotency.run(scope, key, { a: 1 }, () => {
      runs += 1;
      return Promise.resolve({ ok: true });
    });

    expect(runs).toBe(2);
    expect(retried).toEqual({ ok: true });
  });

  it('keeps different scopes apart', async () => {
    // The same key under two operations must not collide.
    const key = unique('key');

    const a = await idempotency.run('scope.a', key, { x: 1 }, () => Promise.resolve('a'));
    const b = await idempotency.run('scope.b', key, { x: 1 }, () => Promise.resolve('b'));

    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});
