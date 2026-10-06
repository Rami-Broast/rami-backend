import path from 'node:path';

import { defineConfig } from 'prisma/config';

// Load .env for local development. Unlike the deprecated `package.json#prisma`
// block, a config file does not read `.env` automatically, so the Prisma CLI
// would otherwise see no DATABASE_URL locally. `dotenv` is a devDependency and
// is therefore absent from pruned production images (`npm prune --omit=dev`);
// there the platform injects env vars directly, so a missing dotenv must be a
// harmless no-op rather than a hard failure during `prisma generate`.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
} catch {
  // dotenv not installed (pruned production build) — nothing to load.
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed/seed.ts',
  },
});
