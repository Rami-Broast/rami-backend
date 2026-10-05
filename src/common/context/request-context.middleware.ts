import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../logger/logger.module';
import { RequestContext } from './request-context';

/** Bound so a hostile client cannot inflate every stored audit row. */
const MAX_USER_AGENT = 512;

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Opens a {@link RequestContext} for every request and seeds it with the
 * correlation id, client IP and user-agent taken from the raw request.
 *
 * The correlation id mirrors the logger's own resolution (honour an inbound
 * `x-correlation-id`, else the id the logger already minted, else a fresh one),
 * so an audit row and the log lines for the same request can be joined on it.
 * The actor is *not* known yet — it is added by the auth guard once resolved —
 * which is why the store is created empty of it here.
 *
 * Everything downstream (guards, interceptors, the handler and the services it
 * calls) runs inside `run()`, so the context follows the request's async chain
 * without being passed as an argument.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContext) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const inbound = firstHeader(req.headers[CORRELATION_ID_HEADER]);
    const existing =
      typeof (req as { id?: unknown }).id === 'string' ? (req as { id: string }).id : undefined;
    const correlationId = inbound ?? existing ?? randomUUID();

    const forwardedFor = firstHeader(req.headers['x-forwarded-for']);
    const ipAddress = forwardedFor?.split(',')[0]?.trim() || req.ip || undefined;

    const userAgent = firstHeader(req.headers['user-agent'])?.slice(0, MAX_USER_AGENT);

    this.context.run({ correlationId, ipAddress, userAgent }, () => {
      next();
    });
  }
}
