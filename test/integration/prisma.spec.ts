import { Test } from '@nestjs/testing';

import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Verifies the real connection lifecycle against a real PostgreSQL instance.
 * Requires DATABASE_URL to point at a reachable database — `docker compose up
 * -d postgres` locally, or the `postgres` service container in CI.
 */
describe('PrismaService (integration)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
  });

  it('connects to the configured database', async () => {
    await expect(prisma.isReachable()).resolves.toBe(true);
  });

  it('executes a parameterised query through the connection pool', async () => {
    const rows = await prisma.$queryRaw<{ result: number }[]>`SELECT 1::int AS result`;

    expect(rows[0].result).toBe(1);
  });

  it('reports the expected PostgreSQL major version', async () => {
    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version() AS version`;

    // The platform targets PostgreSQL 16; a mismatch here means the local or CI
    // database has drifted from what production will run.
    expect(rows[0].version).toContain('PostgreSQL 16');
  });
});
