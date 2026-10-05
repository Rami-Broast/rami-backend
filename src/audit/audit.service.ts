import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ListAuditLogQueryDto } from './dto/audit.dto';

/**
 * The append-only audit log lives in the `AuditLog` table (Phase 3 schema).
 * Rows are written by other modules through {@link AuditRecorder}, which reads
 * the acting actor and correlation id from the request context — this service
 * is read-only, and never exposes a mutation.
 *
 * Owner-only in the seed (`audit:read` is granted only to OWNER), so this
 * service does not apply an extra branch scope on top: an owner sees every
 * row. Ip addresses and user-agent strings are returned to owners for
 * incident review.
 */
const auditView = {
  id: true,
  actorType: true,
  actorUserId: true,
  actorCustomerId: true,
  action: true,
  entityType: true,
  entityId: true,
  branchId: true,
  before: true,
  after: true,
  outcome: true,
  reason: true,
  correlationId: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  actorUser: { select: { id: true, email: true, fullName: true } },
  actorCustomer: { select: { id: true, phone: true, fullName: true } },
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.AuditLogSelect;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.actorCustomerId ? { actorCustomerId: query.actorCustomerId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        select: auditView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }
}
