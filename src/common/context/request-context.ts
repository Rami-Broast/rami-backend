import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { Actor } from '../../auth/types/actor';

/**
 * What is known about the request currently in flight.
 *
 * `actor` is filled in later than the rest: the correlation id, IP and
 * user-agent are read off the raw request the moment it arrives (the
 * middleware), but the actor is only resolved once the auth guard has run. The
 * store is a mutable object held by reference, so the guard mutating `actor`
 * after the fact is seen by everything downstream in the same request.
 */
export interface RequestContextStore {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actor?: Actor;
}

/**
 * Per-request context, carried implicitly rather than threaded through every
 * function signature.
 *
 * This exists so a cross-cutting concern — today the audit log — can learn
 * *who* is acting and *which request* it belongs to without every service
 * method growing an extra argument it would otherwise never use. It is built on
 * Node's own {@link AsyncLocalStorage}, so no dependency is added and the value
 * follows the async call chain of a single request without leaking between
 * concurrent ones.
 *
 * Reads are always defensive: outside a request (a background job, a test that
 * did not wrap the call) `get()` returns `undefined`, and every caller treats
 * that as "no context" rather than failing.
 */
@Injectable()
export class RequestContext {
  private readonly als = new AsyncLocalStorage<RequestContextStore>();

  /** Runs `callback` with `store` as the ambient context for its async chain. */
  run<T>(store: RequestContextStore, callback: () => T): T {
    return this.als.run(store, callback);
  }

  /** The current request's context, or `undefined` outside a request. */
  get(): RequestContextStore | undefined {
    return this.als.getStore();
  }

  /**
   * Records the authenticated actor onto the current context.
   *
   * Called by the auth guard once the actor is resolved from the database. A
   * no-op when there is no active store (a public route reached before the
   * middleware, or a non-HTTP entry point) — the caller never depends on it
   * having succeeded.
   */
  setActor(actor: Actor): void {
    const store = this.als.getStore();
    if (store) {
      store.actor = actor;
    }
  }
}
