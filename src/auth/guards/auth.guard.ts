import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RequestContext } from '../../common/context/request-context';
import { ACTOR_REQUEST_KEY, RequestWithActor } from '../decorators/current-actor.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ActorService } from '../services/actor.service';
import { TokenService } from '../services/token.service';

/**
 * Authenticates every request.
 *
 * Registered globally, so a new endpoint is protected the moment it exists. The
 * alternative — opting in per controller — fails the first time someone forgets,
 * and the failure is silent.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly actorService: ActorService,
    private readonly requestContext: RequestContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Authentication required.');
    }

    const payload = this.tokenService.verifyAccessToken(token);

    // Roles, permissions and branch scope come from the database, never from
    // the token — see ActorService.
    const actor = await this.actorService.resolve(payload.typ, payload.sub);
    request[ACTOR_REQUEST_KEY] = actor;

    // Make the resolved actor available to the request context, so a
    // cross-cutting consumer (the audit recorder) can attribute an action
    // without every service method taking the actor as an argument.
    this.requestContext.setActor(actor);

    return true;
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header) {
      return undefined;
    }

    const [scheme, value] = header.split(' ');

    return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
  }
}
