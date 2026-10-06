import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { Actor, ActorKind } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { DEFAULT_DOCKET_TEMPLATE } from '../../src/receipt-templates/receipt-template';
import { ReceiptTemplatesModule } from '../../src/receipt-templates/receipt-templates.module';
import { ReceiptTemplatesService } from '../../src/receipt-templates/receipt-templates.service';
import { createBranch } from './helpers/factories';

function owner(): Actor {
  return {
    kind: ActorKind.Staff,
    id: null,
    permissions: new Set<string>(),
    branchScope: { kind: 'ALL' },
  } as unknown as Actor;
}

function branchStaff(branchIds: string[]): Actor {
  return {
    kind: ActorKind.Staff,
    id: null,
    permissions: new Set<string>(),
    branchScope: { kind: 'ASSIGNED', branchIds },
  } as unknown as Actor;
}

describe('ReceiptTemplatesService (integration)', () => {
  const prisma = new PrismaClient();
  let templates: ReceiptTemplatesService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, ReceiptTemplatesModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    templates = app.get(ReceiptTemplatesService);
    close = () => app.close();
  });

  // Both ends: the suites share one database, so a template left by another
  // spec would make "before anyone has edited anything" a different test than
  // it says it is.
  beforeEach(async () => {
    await prisma.receiptTemplate.deleteMany({});
  });

  afterEach(async () => {
    await prisma.receiptTemplate.deleteMany({});
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  it('serves the shipped template before anyone has edited anything', async () => {
    const { template, updatedAt } = await templates.organisationDefault();

    expect(template).toEqual(DEFAULT_DOCKET_TEMPLATE);
    expect(updatedAt).toBeNull();
  });

  it('saves the organisation default and keeps serving one of them', async () => {
    await templates.saveOrganisationDefault(owner(), {
      ...DEFAULT_DOCKET_TEMPLATE,
      thankYouLines: ['Shukran'],
    });
    await templates.saveOrganisationDefault(owner(), {
      ...DEFAULT_DOCKET_TEMPLATE,
      thankYouLines: ['Shukran jazeelan'],
    });

    const { template } = await templates.organisationDefault();
    expect(template.thankYouLines).toEqual(['Shukran jazeelan']);
    // Not two defaults with nothing to say which a branch would print.
    expect(await prisma.receiptTemplate.count({ where: { branchId: null } })).toBe(1);
  });

  it('the database refuses a second organisation default outright', async () => {
    // The application only ever writes one, but a partial unique index is what
    // actually holds it: two concurrent saves both pass an application check.
    await templates.saveOrganisationDefault(owner(), DEFAULT_DOCKET_TEMPLATE);

    await expect(
      prisma.receiptTemplate.create({ data: { branchId: null, config: {} } }),
    ).rejects.toThrow();
  });

  it('resolves a branch as the owner default plus that branch’s override', async () => {
    const branch = await createBranch(prisma);
    await templates.saveOrganisationDefault(owner(), {
      ...DEFAULT_DOCKET_TEMPLATE,
      brandLines: ['Rami Broast'],
    });
    await templates.saveBranchOverride(owner(), branch.id, { thankYouLines: ['See you in Olaya'] });

    const { resolved, organisationDefault, override } = await templates.forBranch(
      owner(),
      branch.id,
    );

    expect(resolved.brandLines).toEqual(['Rami Broast']);
    expect(resolved.thankYouLines).toEqual(['See you in Olaya']);
    // The override is returned beside the result so an editor can show what
    // this branch changed, not only what it ends up printing.
    expect(override).toEqual({ thankYouLines: ['See you in Olaya'] });
    expect(organisationDefault.thankYouLines).toEqual(DEFAULT_DOCKET_TEMPLATE.thankYouLines);
  });

  it('drops a branch back to the owner’s template', async () => {
    const branch = await createBranch(prisma);
    await templates.saveBranchOverride(owner(), branch.id, { thankYouLines: ['Temporary'] });

    const resolved = await templates.clearBranchOverride(owner(), branch.id);

    expect(resolved.thankYouLines).toEqual(DEFAULT_DOCKET_TEMPLATE.thankYouLines);
    expect(await prisma.receiptTemplate.count({ where: { branchId: branch.id } })).toBe(0);
  });

  it('will not let one branch read or write another’s template', async () => {
    // Branch isolation is enforced here, not in the app that renders it.
    const mine = await createBranch(prisma);
    const theirs = await createBranch(prisma);
    const staff = branchStaff([mine.id]);

    await expect(templates.forBranch(staff, theirs.id)).rejects.toThrow(ForbiddenException);
    await expect(
      templates.saveBranchOverride(staff, theirs.id, { thankYouLines: ['no'] }),
    ).rejects.toThrow(ForbiddenException);
    await expect(templates.clearBranchOverride(staff, theirs.id)).rejects.toThrow(
      ForbiddenException,
    );

    await expect(templates.forBranch(staff, mine.id)).resolves.toBeDefined();
  });
});
