import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ACTOR_REQUEST_KEY, RequestWithActor } from '../../auth/decorators/current-actor.decorator';
import { BRANCH_PARAM_KEY } from '../decorators/branch-scoped.decorator';
import { assertBranchAccess } from '../branch-scope';

/**
 * Validates a branch identifier taken from the request against the actor's
 * scope, before the handler runs.
 *
 * This covers the common case — a branch named in the route or query — so the
 * handler never has to remember. Queries that *list* across branches still need
 * `branchScopeFilter`, because a guard cannot scope a result set.
 */
@Injectable()
export class BranchAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName = this.reflector.getAllAndOverride<string | undefined>(BRANCH_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!paramName) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request[ACTOR_REQUEST_KEY];

    if (!actor) {
      throw new ForbiddenException('You do not have access to this branch.');
    }

    const params = request.params as Record<string, string | undefined>;
    const query = request.query as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const raw = params[paramName] ?? query[paramName] ?? body[paramName];

    // A route that declares itself branch-scoped but supplies no branch is a
    // wiring mistake. Denying is the safe reading — the alternative is silently
    // skipping the isolation check on a route that asked for it.
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new ForbiddenException('You do not have access to this branch.');
    }

    assertBranchAccess(actor, raw);

    return true;
  }
}
