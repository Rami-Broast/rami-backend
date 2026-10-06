import { Module } from '@nestjs/common';

import { RequestContextModule } from '../common/context/request-context.module';
import { AuditController } from './audit.controller';
import { AuditRecorder } from './audit-recorder.service';
import { AuditService } from './audit.service';

/**
 * The audit log: a read surface and a write surface.
 *
 * - {@link AuditService} is the owner-only read API (`audit:read`).
 * - {@link AuditRecorder} is the writer other modules inject to record an
 *   action. It is exported so a feature module can import this one and record
 *   against the log; it reads the actor and correlation id from the global
 *   request context, so callers pass only what changed.
 *
 * The database is reached via the global PrismaModule and the request context
 * via the global RequestContextModule, so this module imports neither.
 */
@Module({
  // RequestContextModule is global, but importing it here guarantees the
  // recorder's dependency on RequestContext resolves anywhere AuditModule is
  // used — including partial module graphs composed in integration tests.
  imports: [RequestContextModule],
  controllers: [AuditController],
  providers: [AuditService, AuditRecorder],
  exports: [AuditService, AuditRecorder],
})
export class AuditModule {}
