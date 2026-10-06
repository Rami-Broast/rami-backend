import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ACTOR_REQUEST_KEY, RequestWithActor } from '../decorators/current-actor.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)`.
 *
 * Runs after {@link AuthGuard}, so an actor is present. Customers hold no
 * permissions at all, which means any permission-gated route rejects them
 * without needing a separate staff-only check.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request[ACTOR_REQUEST_KEY];

    if (!actor) {
      // A permission-gated route that is also marked public is a wiring
      // mistake. Deny rather than let it through.
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    const missing = required.filter((permission) => !actor.permissions.has(permission));

    if (missing.length > 0) {
      // The response does not name the missing permissions — that would map out
      // the permission model for anyone probing the API.
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    return true;
  }
}
