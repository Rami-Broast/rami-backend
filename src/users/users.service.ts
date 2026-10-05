import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit-actions';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { Actor, ActorKind } from '../auth/types/actor';
import { PasswordService } from '../auth/services/password.service';
import { TokenService } from '../auth/services/token.service';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignRoleDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
  UpdateUserDto,
} from './dto/user.dto';

/** The seeded system role reserved for organisation-wide staff. */
const OWNER_ROLE = 'OWNER';

/**
 * The public shape of a staff user. `passwordHash` is deliberately excluded —
 * a bug that added it to this selector would leak every hash. Role grants are
 * flattened enough for the admin UI to render without a second round-trip.
 */
const userView = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  roles: {
    select: {
      id: true,
      branchId: true,
      role: { select: { id: true, name: true, description: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.UserSelect;

/**
 * Staff-user administration (users:read / users:write, plus roles:assign for
 * role changes).
 *
 * A staff user is not branch-owned: the record itself belongs to the
 * organisation. Branch scoping applies to what a given user *sees*, which is
 * carried by their `UserRole.branchId` grants — not by the user row.
 * `users:*` is deliberately owner-only in the seed, so this service does not
 * apply an extra branch filter on top: OWNER sees every staff account.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(dto: CreateUserDto) {
    const normalisedEmail = dto.email.toLowerCase();

    if (dto.role) {
      // Validate the role grant up front, so a create+assign call never
      // half-succeeds (user row created, role assignment rejected).
      await this.ensureAssignable(dto.role, dto.branchId);
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: normalisedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('A user with that email already exists.');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalisedEmail,
          fullName: dto.fullName,
          passwordHash,
        },
      });

      if (dto.role) {
        const role = await tx.role.findUniqueOrThrow({ where: { name: dto.role } });
        await tx.userRole.create({
          data: { userId: user.id, roleId: role.id, branchId: dto.branchId ?? null },
        });
      }

      return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: userView });
    });

    // After commit, best-effort — the password is never part of the snapshot.
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_CREATE,
      entityType: AUDIT_ENTITIES.USER,
      entityId: created.id,
      branchId: dto.branchId ?? null,
      after: { email: created.email, fullName: created.fullName, role: dto.role ?? null },
    });

    return created;
  }

  async list(query: ListUsersQueryDto) {
    const filters: Prisma.UserWhereInput[] = [];

    if (!query.includeDeleted) {
      filters.push({ deletedAt: null });
    }

    if (query.isActive !== undefined) {
      filters.push({ isActive: query.isActive });
    }

    if (query.q) {
      // Case-insensitive substring on email OR full name. `mode: 'insensitive'`
      // is a Postgres-only feature and the schema is Postgres.
      const q = query.q;
      filters.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (query.role || query.branchId) {
      filters.push({
        roles: {
          some: {
            ...(query.role ? { role: { is: { name: query.role } } } : {}),
            ...(query.branchId ? { branchId: query.branchId } : {}),
          },
        },
      });
    }

    const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  async getById(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: userView,
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return user;
  }

  async update(actor: Actor, id: string, dto: UpdateUserDto) {
    const target = await this.getById(id);

    if (dto.isActive === false) {
      this.assertNotSelf(actor, target.id, 'deactivate yourself');
      await this.ensureNotLastActiveOwner(target.id);
    }

    // Changing the sign-in address is a credential change, not a profile edit:
    // the person now types something different to get in, and anyone who knew
    // the old address no longer has a working half of the pair.
    const emailChanged = dto.email !== undefined && dto.email !== target.email;

    const updated = await this.prisma.user
      .update({
        where: { id },
        data: {
          ...(emailChanged ? { email: dto.email } : {}),
          ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        select: userView,
      })
      .catch((error: unknown) => {
        // The unique index is the guarantee — a read-then-write check here
        // would let two concurrent requests both pass it.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Another account already uses that email address.');
        }
        throw error;
      });

    if (emailChanged) {
      // Same reasoning as a password reset: the credentials this account signs
      // in with have changed, so nothing issued against the old ones should
      // keep working.
      await this.tokens.revokeAllForActor(
        { kind: ActorKind.Staff, id },
        'Sign-in address changed by administrator',
      );
    }

    if (dto.isActive === false) {
      // Revoke every live session so a deactivated account cannot keep using
      // an already-issued token until it expires on its own.
      await this.tokens.revokeAllForActor(
        { kind: ActorKind.Staff, id },
        'Account deactivated by administrator',
      );
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_UPDATE,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      before: { email: target.email, fullName: target.fullName, isActive: target.isActive },
      after: { email: updated.email, fullName: updated.fullName, isActive: updated.isActive },
    });

    return updated;
  }

  async resetPassword(actor: Actor, id: string, dto: ResetPasswordDto) {
    await this.getById(id);

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.user.update({ where: { id }, data: { passwordHash } });

    // An administrator forcing a new password is treated as "the previous
    // password may be compromised": revoke every live session for the target
    // so an attacker cannot keep using an issued refresh token.
    await this.tokens.revokeAllForActor(
      { kind: ActorKind.Staff, id },
      'Password reset by administrator',
    );

    // The operator (and the request) are attributed from the ambient request
    // context; no credential is ever part of the row.
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      reason: 'Password reset by administrator; live sessions revoked.',
    });

    return { id, resetAt: new Date().toISOString(), resetBy: actor.id };
  }

  async assignRole(id: string, dto: AssignRoleDto) {
    await this.getById(id);
    await this.ensureAssignable(dto.role, dto.branchId);

    const role = await this.prisma.role.findUniqueOrThrow({ where: { name: dto.role } });

    // A grant is unique per (user, role, branch) — trying to add one that
    // already exists is a no-op rather than a 500. The unique constraint
    // catches concurrent writes; the find-first catches the common case
    // cheaply.
    const existing = await this.prisma.userRole.findFirst({
      where: { userId: id, roleId: role.id, branchId: dto.branchId ?? null },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('This user already holds that role for that branch.');
    }

    await this.prisma.userRole.create({
      data: { userId: id, roleId: role.id, branchId: dto.branchId ?? null },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_ROLE_ASSIGN,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      branchId: dto.branchId ?? null,
      after: { role: dto.role, branchId: dto.branchId ?? null },
    });

    return this.getById(id);
  }

  async revokeRole(actor: Actor, id: string, userRoleId: string) {
    const grant = await this.prisma.userRole.findFirst({
      where: { id: userRoleId, userId: id },
      select: { id: true, role: { select: { name: true } } },
    });

    if (!grant) {
      throw new NotFoundException('Role assignment not found.');
    }

    if (grant.role.name === OWNER_ROLE) {
      this.assertNotSelf(actor, id, 'revoke your own OWNER role');
      await this.ensureNotLastActiveOwner(id);
    }

    await this.prisma.userRole.delete({ where: { id: userRoleId } });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_ROLE_REVOKE,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      before: { role: grant.role.name, userRoleId },
    });

    return this.getById(id);
  }

  private async ensureAssignable(roleName: string, branchId?: string): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { name: roleName },
      select: { name: true },
    });
    if (!role) {
      throw new BadRequestException(
        `Role ${roleName} is not defined. Seed the roles table first (npm run prisma:seed).`,
      );
    }

    if (role.name !== OWNER_ROLE && !branchId) {
      throw new BadRequestException(
        `branchId is required for role ${role.name}. Only OWNER is granted across all branches.`,
      );
    }

    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) {
        throw new BadRequestException('branchId does not match any active branch.');
      }
    }
  }

  private assertNotSelf(actor: Actor, targetUserId: string, verb: string): void {
    if (actor.kind === ActorKind.Staff && actor.id === targetUserId) {
      throw new ForbiddenException(`You cannot ${verb}.`);
    }
  }

  /**
   * Guards against locking every OWNER out of the organisation.
   *
   * Called before a deactivation or an OWNER-role revoke: counts the *other*
   * active OWNERs, and rejects the change if the target is the last one. The
   * SQL runs untouched by the caller — a bug in the calling method cannot make
   * this check pass when it should fail.
   */
  private async ensureNotLastActiveOwner(targetUserId: string): Promise<void> {
    const otherOwners = await this.prisma.user.count({
      where: {
        id: { not: targetUserId },
        isActive: true,
        deletedAt: null,
        roles: { some: { role: { is: { name: OWNER_ROLE } } } },
      },
    });

    if (otherOwners === 0) {
      throw new ForbiddenException('This is the only active OWNER — promote another owner first.');
    }
  }
}
