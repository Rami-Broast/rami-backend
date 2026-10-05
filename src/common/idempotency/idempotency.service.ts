import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';

/** How long a completed record is replayable before a purge may remove it. */
const RETENTION_HOURS = 24;

/**
 * Makes a write safe to retry.
 *
 * Placing an order was not idempotent: eight identical concurrent requests
 * created eight real orders, and a mobile client that timed out and retried
 * produced a duplicate the kitchen would cook. Payments and refunds were
 * already idempotent; order creation, the one a customer triggers over a phone
 * network, was not. The `IdempotencyRecord` table existed the whole time and
 * nothing read or wrote it — a table advertising a guarantee the system did not
 * provide.
 *
 * The guarantee here is the database's, not this code's: `@@unique([scope, key])`
 * is what makes two concurrent requests with the same key resolve to one
 * winner. A read-then-write check would let both through, which is the whole
 * class of bug this exists to prevent.
 *
 * Three outcomes for a repeat key:
 *
 * - **Completed** — the stored response is replayed. The caller cannot tell
 *   whether they got the original or the replay, which is the point.
 * - **In progress** — 409. The first request is still running; a client that
 *   retried early must wait rather than race it.
 * - **Failed** — the key is released and the work runs again. A genuine failure
 *   should be retryable; refusing for ever would strand the customer.
 *
 * The request body is hashed and compared, so the same key sent with a
 * *different* order is refused rather than silently answered with someone
 * else's order.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Stable hash of the request, so a reused key with new content is caught. */
  static hash(payload: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(payload ?? null))
      .digest('hex');
  }

  /**
   * Runs `work` at most once per `(scope, key)`.
   *
   * With no key the work simply runs — idempotency is opt-in per request, and a
   * client that does not send a key gets exactly today's behaviour rather than
   * an error.
   */
  async run<T>(
    scope: string,
    key: string | undefined,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!key) {
      return work();
    }

    const requestHash = IdempotencyService.hash(request);
    const claimed = await this.claim(scope, key, requestHash);

    if (claimed.replay) {
      return claimed.response as T;
    }

    try {
      const result = await work();

      await this.prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: {
          status: IdempotencyStatus.COMPLETED,
          completedAt: new Date(),
          // Serialised the way it will cross the wire, so a replay and the
          // original produce the same JSON — Decimal and Date included.
          responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        },
      });

      return result;
    } catch (error) {
      // Mark failed rather than delete, so a concurrent retry sees a decided
      // state instead of an absent one. Best-effort: the original error is what
      // the caller needs, and losing the bookkeeping must not replace it.
      await this.prisma.idempotencyRecord
        .update({
          where: { scope_key: { scope, key } },
          data: { status: IdempotencyStatus.FAILED, completedAt: new Date() },
        })
        .catch((bookkeeping: unknown) => {
          this.logger.warn(`could not mark idempotency record failed: ${String(bookkeeping)}`);
        });

      throw error;
    }
  }

  /**
   * Takes the key, or reports what the existing record means for this caller.
   *
   * The insert is the lock: two concurrent requests race on the unique index
   * and exactly one creates the row.
   */
  private async claim(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<{ replay: true; response: unknown } | { replay: false }> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          key,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000),
        },
      });

      return { replay: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key } },
    });

    if (!existing) {
      // Raced with a purge between the failed insert and this read. Treat the
      // key as free rather than failing a legitimate request.
      return { replay: false };
    }

    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'This idempotency key was already used for a different request.',
      );
    }

    if (existing.status === IdempotencyStatus.COMPLETED) {
      return { replay: true, response: existing.responseBody };
    }

    if (existing.status === IdempotencyStatus.FAILED) {
      await this.prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: {
          status: IdempotencyStatus.IN_PROGRESS,
          lockedAt: new Date(),
          completedAt: null,
          responseBody: Prisma.DbNull,
        },
      });

      return { replay: false };
    }

    throw new ConflictException(
      'A request with this idempotency key is still being processed. Try again shortly.',
    );
  }
}
