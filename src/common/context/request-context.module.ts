import { Global, Module } from '@nestjs/common';

import { RequestContext } from './request-context';

/**
 * Global so the auth guard (which fills in the actor) and any cross-cutting
 * consumer (the audit recorder) can inject {@link RequestContext} without every
 * feature module re-importing this one — the same reason PrismaModule and
 * AuthModule are global.
 *
 * The middleware that opens the context per request is registered in AppModule,
 * because middleware is applied by the module that composes the routes.
 */
@Global()
@Module({
  providers: [RequestContext],
  exports: [RequestContext],
})
export class RequestContextModule {}
