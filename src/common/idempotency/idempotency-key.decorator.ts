import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

/** Max accepted key length — long enough for a UUID, short enough to bound. */
const MAX_KEY_LENGTH = 255;

/**
 * The request's `Idempotency-Key` header, if it sent one.
 *
 * Returns `undefined` rather than throwing when absent: idempotency is opt-in,
 * and a client that does not send a key gets today's behaviour. Over-long or
 * blank values are dropped for the same reason — a malformed header should not
 * fail an otherwise valid order.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 && trimmed.length <= MAX_KEY_LENGTH ? trimmed : undefined;
  },
);
