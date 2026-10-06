import { Module } from '@nestjs/common';

import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';

/**
 * The socket transport, wired once at the application root.
 *
 * Imports `RealtimeModule` for the `RealtimeService` the gateway registers
 * its server into, and relies on the global `AuthModule` for token
 * verification and actor resolution on the handshake — the same
 * authorisation the HTTP guards use, so a socket can never see more than the
 * REST API would grant the same caller.
 *
 * Kept separate from `RealtimeModule` so feature modules can depend on the
 * lightweight service without pulling the gateway (and its auth deps) into
 * their graph.
 */
@Module({
  imports: [RealtimeModule],
  providers: [RealtimeGateway],
})
export class RealtimeGatewayModule {}
