import { Module } from '@nestjs/common';

import { RealtimeService } from './realtime.service';

/**
 * The realtime domain facade.
 *
 * Provides only `RealtimeService` — which has no injected dependencies — so
 * any feature module (or integration test composing one) can import this to
 * push events without dragging in the socket transport or its auth
 * machinery. The transport itself lives in `RealtimeGatewayModule`, wired
 * once at the application root.
 */
@Module({
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
