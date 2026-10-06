import { Injectable, Logger } from '@nestjs/common';
import { ActorType, AuditOutcome, Prisma } from '@prisma/client';

import { RequestContext } from '../common/context/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { actorToFields, sanitizeSnapshot, type AuditEntry } from './audit-entry';

/**
 * Writes rows into the append-only audit log.
 *
 * ## Best-effort, and post-commit by convention
 *
 * `record()` never throws. An audit write failing must not roll back or break
 * the action it was recording — the same rule the notification and loyalty
 * triggers already follow, and for the same reason: a refund that succeeded
 * must not be undone because we could not describe it. Callers therefore invoke
 * this **after** their own database transaction has committed, passing the
 * before/after snapshots they captured around the change. A row is written with
 * the base client (not the caller's transaction), so it stands on its own.
 *
 * The trade this makes: a crash in the narrow window between an action
 * committing and its audit row being written leaves that action unrecorded. A
 * compliance-grade guarantee would need a transactional outbox; that is noted
 * in `README.md` as deliberate follow-up rather than pretended here.
 *
 * ## Where the "who" comes from
 *
 * Actor, correlation id, IP and user-agent are read from {@link RequestContext}
 * — no method signature has to grow a context argument. An action on a public
 * route (a staff login) has no ambient actor yet, so those callers pass `actor`
 * on the entry explicitly.
 */
@Injectable()
export class AuditRecorder {
  private readonly logger = new Logger(AuditRecorder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const ctx = this.context.get();
      // Precedence: an explicit actor, then a staff id named on the entry (a
      // login), then the ambient actor from the request context, then system.
      const { actorType, actorUserId, actorCustomerId } =
        entry.actorUserId && !entry.actor
          ? { actorType: ActorType.USER, actorUserId: entry.actorUserId, actorCustomerId: null }
          : actorToFields(entry.actor ?? ctx?.actor);

      const before = sanitizeSnapshot(entry.before);
      const after = sanitizeSnapshot(entry.after);

      await this.prisma.auditLog.create({
        data: {
          actorType,
          actorUserId,
          actorCustomerId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          branchId: entry.branchId ?? null,
          before: before === undefined ? undefined : (before as Prisma.InputJsonValue),
          after: after === undefined ? undefined : (after as Prisma.InputJsonValue),
          outcome: entry.outcome ?? AuditOutcome.SUCCESS,
          reason: entry.reason ?? null,
          correlationId: ctx?.correlationId ?? null,
          ipAddress: ctx?.ipAddress ?? null,
          userAgent: ctx?.userAgent ?? null,
        },
      });
    } catch (error) {
      // Swallowed on purpose — see the class comment. A failed audit write is
      // logged so it is not silent, but it never propagates.
      this.logger.warn(
        `Failed to write audit log for ${entry.action} on ${entry.entityType} ${entry.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
