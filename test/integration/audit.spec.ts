import { Test } from '@nestjs/testing';
import { ActorType, AuditOutcome, PrismaClient } from '@prisma/client';

import { AuditModule } from '../../src/audit/audit.module';
import { AuditRecorder } from '../../src/audit/audit-recorder.service';
import { AuditService } from '../../src/audit/audit.service';
import { AUDIT_ACTIONS } from '../../src/audit/audit-actions';
import { AuthModule } from '../../src/auth/auth.module';
import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { RequestContext } from '../../src/common/context/request-context';
import { RequestContextModule } from '../../src/common/context/request-context.module';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { unique } from './helpers/factories';

/**
 * The audit log against a real database.
 *
 * The point of this suite is the thing unit tests cannot show: that a real
 * action actually *writes a row*, attributed to the right actor and carrying
 * the request's correlation id — and that the writer never re-stores a
 * credential. Before this module existed there was a read API over an
 * always-empty table; a regression that quietly stopped writing would pass
 * every other suite.
 */
describe('Audit log (integration)', () => {
  const prisma = new PrismaClient();
  let users: UsersService;
  let recorder: AuditRecorder;
  let audit: AuditService;
  let context: RequestContext;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        RequestContextModule,
        AuthModule,
        AuditModule,
        UsersModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    users = app.get(UsersService);
    recorder = app.get(AuditRecorder);
    audit = app.get(AuditService);
    context = app.get(RequestContext);
    close = () => app.close();

    for (const name of ['OWNER', 'BRANCH_ADMIN', 'DRIVER', 'KITCHEN']) {
      await prisma.role.upsert({ where: { name }, update: {}, create: { name, isSystem: true } });
    }
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  function ownerActor(id: string): Actor {
    return {
      kind: ActorKind.Staff,
      id,
      email: 'owner@test',
      fullName: 'Owner',
      roles: ['OWNER'],
      permissions: new Set(['users:read', 'users:write', 'roles:assign']),
      branchScope: { kind: 'ALL' },
    };
  }

  it('writes a row attributed to the request-context actor, with the correlation id', async () => {
    const operator = await prisma.user.create({
      data: { email: unique('op'), fullName: 'Operator', passwordHash: 'x' },
    });

    // Simulate what the middleware + guard do for a real request: open a context
    // carrying the correlation id, then set the resolved actor onto it.
    const created = await context.run(
      { correlationId: 'corr-123', ipAddress: '10.0.0.9' },
      async () => {
        context.setActor(ownerActor(operator.id));
        return users.create({
          email: unique('new'),
          fullName: 'New Staff',
          password: 'a-strong-password',
        });
      },
    );

    const rows = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.USER_CREATE, entityId: created.id },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actorType).toBe(ActorType.USER);
    expect(row.actorUserId).toBe(operator.id);
    expect(row.correlationId).toBe('corr-123');
    expect(row.ipAddress).toBe('10.0.0.9');
    expect(row.outcome).toBe(AuditOutcome.SUCCESS);
    // The password must never appear anywhere in the stored snapshot.
    expect(JSON.stringify(row.after)).not.toContain('a-strong-password');
    expect(JSON.stringify(row)).not.toContain('a-strong-password');
  });

  it('attributes an action taken outside any request to the system', async () => {
    const target = await prisma.user.create({
      data: { email: unique('sys'), fullName: 'Sys Target', passwordHash: 'x' },
    });

    await recorder.record({
      action: AUDIT_ACTIONS.USER_UPDATE,
      entityType: 'User',
      entityId: target.id,
      after: { note: 'no ambient context' },
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.USER_UPDATE, entityId: target.id },
    });
    expect(row.actorType).toBe(ActorType.SYSTEM);
    expect(row.actorUserId).toBeNull();
    expect(row.correlationId).toBeNull();
  });

  it('is surfaced by the read service and filterable by entity', async () => {
    const target = await prisma.user.create({
      data: { email: unique('read'), fullName: 'Read Target', passwordHash: 'x' },
    });

    await recorder.record({
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
      entityType: 'User',
      entityId: target.id,
      reason: 'test',
    });

    const { data } = await audit.list({
      entityId: target.id,
      skip: 0,
      limit: 25,
    } as Parameters<AuditService['list']>[0]);

    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.every((r) => r.entityId === target.id)).toBe(true);
  });

  it('never lets a write failure throw into the caller', async () => {
    // An entity id far longer than any column bound would fail the insert; the
    // recorder must swallow it. (entityId is unbounded text, so force a
    // different failure: a null-byte, which Postgres rejects in text.)
    await expect(
      recorder.record({
        action: AUDIT_ACTIONS.USER_UPDATE,
        entityType: 'User',
        entityId: 'bad\u0000id',
      }),
    ).resolves.toBeUndefined();
  });
});
