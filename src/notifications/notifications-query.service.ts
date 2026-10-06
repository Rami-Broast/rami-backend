import { Injectable } from '@nestjs/common';

import { Actor } from '../auth/types/actor';
import { buildPaginationMeta, PaginationQueryDto } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read side of notifications: a customer's own feed. Kept separate from the
 * dispatch service so the two concerns — sending and reading — do not entangle.
 */
@Injectable()
export class NotificationsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(actor: Actor, query: PaginationQueryDto) {
    const where = { customerId: actor.id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          data: true,
          orderId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }
}
