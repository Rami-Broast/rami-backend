import { Module } from '@nestjs/common';

import { IdempotencyService } from './idempotency.service';

/**
 * Retry safety for writes.
 *
 * Imported explicitly by the modules that use it rather than declared global.
 * A global provider is invisible in a module's own dependency list and, more
 * practically, absent from any integration test that composes feature modules
 * directly — which is most of them. An explicit import says where the
 * dependency is used and keeps those tests working.
 */
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
