import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';

import { Actor } from '../types/actor';

export const ACTOR_REQUEST_KEY = 'actor';

export interface RequestWithActor extends Request {
  [ACTOR_REQUEST_KEY]?: Actor;
}

/**
 * Injects the authenticated actor.
 *
 * Throws rather than returning undefined if the actor is missing: reaching a
 * handler without one means the route escaped the auth guard, and failing loudly
 * is far safer than a handler quietly treating "nobody" as a valid caller.
 * Public routes must not use this decorator.
 */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithActor>();
  const actor = request[ACTOR_REQUEST_KEY];

  if (!actor) {
    throw new InternalServerErrorException();
  }

  return actor;
});
