import { Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ActorKind, BranchScope, CustomerActor, StaffActor } from '../types/actor';

/** The role that reaches every branch. Seeded and marked `isSystem`. */
export const OWNER_ROLE = 'OWNER';

/**
 * Resolves an authenticated identity into what it may actually do.
 *
 * This runs on every authenticated request rather than trusting claims baked
 * into a token. The cost is one query; the benefit is that revoking a role or a
 * branch assignment takes effect on the next request instead of whenever the
 * holder's token expires. For a system managing money and multi-branch access,
 * a window of stale privilege is not acceptable.
 */
@Injectable()
export class ActorService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveStaff(userId: string): Promise<StaffActor> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        roles: {
          select: {
            branchId: true,
            role: {
              select: {
                name: true,
                permissions: { select: { permission: { select: { code: true } } } },
              },
            },
          },
        },
      },
    });

    // A deactivated or deleted account fails exactly like an unknown one.
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Authentication required.');
    }

    const roles = new Set<string>();
    const permissions = new Set<string>();
    const assignedBranchIds = new Set<string>();
    let reachesAllBranches = false;

    for (const grant of user.roles) {
      roles.add(grant.role.name);

      for (const entry of grant.role.permissions) {
        permissions.add(entry.permission.code);
      }

      // A null branchId means the grant is organisation-wide. Only OWNER is
      // seeded that way; any other role granted without a branch would be a
      // provisioning mistake, so it is not silently treated as global.
      if (grant.branchId === null) {
        if (grant.role.name === OWNER_ROLE) {
          reachesAllBranches = true;
        }
      } else {
        assignedBranchIds.add(grant.branchId);
      }
    }

    return {
      kind: ActorKind.Staff,
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: [...roles],
      permissions,
      branchScope: this.buildBranchScope(reachesAllBranches, assignedBranchIds),
    };
  }

  private buildBranchScope(reachesAll: boolean, assigned: Set<string>): BranchScope {
    if (reachesAll) {
      return { kind: 'ALL' };
    }

    if (assigned.size > 0) {
      return { kind: 'ASSIGNED', branchIds: [...assigned] };
    }

    // No assignment means no branch reach. Never a fallback to "everything".
    return { kind: 'NONE' };
  }

  async resolveCustomer(customerId: string): Promise<CustomerActor> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true, phone: true, isActive: true },
    });

    if (!customer || !customer.isActive) {
      throw new UnauthorizedException('Authentication required.');
    }

    return {
      kind: ActorKind.Customer,
      id: customer.id,
      phone: customer.phone,
      permissions: new Set<string>(),
      branchScope: { kind: 'NONE' },
    };
  }

  resolve(kind: ActorKind, id: string): Promise<Actor> {
    return kind === ActorKind.Staff ? this.resolveStaff(id) : this.resolveCustomer(id);
  }
}
