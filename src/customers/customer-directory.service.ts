import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Actor, isStaff } from '../auth/types/actor';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ListCustomersQueryDto } from './dto/customer-directory.dto';

/**
 * The staff-facing customer view. Deliberately narrow — a directory listing
 * doesn't need the full address book or order history inline. Detail
 * endpoints pull those separately.
 */
const customerListView = {
  id: true,
  phone: true,
  email: true,
  fullName: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  phoneVerifiedAt: true,
  _count: { select: { orders: true, addresses: { where: { deletedAt: null } } } },
} satisfies Prisma.CustomerSelect;

const customerDetailView = {
  id: true,
  phone: true,
  email: true,
  fullName: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  phoneVerifiedAt: true,
  addresses: {
    where: { deletedAt: null },
    select: {
      id: true,
      label: true,
      line1: true,
      line2: true,
      district: true,
      city: true,
      postalCode: true,
      isDefault: true,
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  },
  _count: { select: { orders: true } },
} satisfies Prisma.CustomerSelect;

/**
 * Staff-side customer directory (`customers:read`).
 *
 * Split from `CustomersService` because that service manages the *caller's own*
 * addresses (customer-facing); this one is the staff read view over the whole
 * `Customer` table. Keeping them in separate classes prevents a bug in one
 * from ever silently applying to the other (a staff read is not a self-read).
 *
 * Branch scoping: a staff caller with `branchScope.kind === 'ASSIGNED'` only
 * sees customers who have ordered from at least one of their branches. OWNER
 * (kind `ALL`) sees every customer. The filter is applied at the SQL layer via
 * the `orders.some.branchId` sub-clause so it cannot be bypassed by page/limit
 * tricks. `customers:read` is deliberately never granted to a role with scope
 * `NONE` (staff without any branch would otherwise see the whole table for
 * free); if that ever changes the empty-result branch here holds.
 */
@Injectable()
export class CustomerDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: Actor, query: ListCustomersQueryDto) {
    const filters: Prisma.CustomerWhereInput[] = [{ deletedAt: null }];

    if (query.isActive !== undefined) {
      filters.push({ isActive: query.isActive });
    }

    if (query.q) {
      const q = query.q;
      filters.push({
        OR: [
          { phone: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const scope = this.scopeFilter(actor);
    if (scope) {
      filters.push(scope);
    }

    const where: Prisma.CustomerWhereInput = { AND: filters };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        select: customerListView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  async getById(actor: Actor, id: string) {
    const scope = this.scopeFilter(actor);
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null, ...(scope ?? {}) },
      select: customerDetailView,
    });

    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }

    return customer;
  }

  /**
   * Returns null when the actor sees every customer (OWNER). Returns an
   * "orders touch one of my branches" clause for a branch-scoped actor.
   * Returns a never-match clause for anything else — customers:read is granted
   * to owners and branch admins only, so this branch is the belt to the
   * server-side belt-and-braces.
   */
  private scopeFilter(actor: Actor): Prisma.CustomerWhereInput | null {
    if (!isStaff(actor)) {
      return { id: '__never__' };
    }

    const scope = actor.branchScope;
    switch (scope.kind) {
      case 'ALL':
        return null;
      case 'ASSIGNED':
        return {
          orders: { some: { branchId: { in: [...scope.branchIds] } } },
        };
      case 'NONE':
        return { id: '__never__' };
    }
  }
}
