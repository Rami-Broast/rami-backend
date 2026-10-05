/**
 * Provisions a staff account.
 *
 * Deliberately a script and not part of the seed. Seeding a user would mean
 * every environment — including production — starts with an account whose
 * existence, and possibly whose password, is written down in the repository.
 * Creating staff is an explicit, audited act.
 *
 * Usage:
 *
 *   STAFF_EMAIL=owner@example.com \
 *   STAFF_PASSWORD='...' \
 *   STAFF_NAME='Full Name' \
 *   STAFF_ROLE=OWNER \
 *   [STAFF_BRANCH_CODE=BR-001] \
 *   npx ts-node scripts/create-staff-user.ts
 *
 * The password is read from the environment rather than a command-line
 * argument, because arguments are visible to every process on the host and are
 * written to shell history.
 *
 * OWNER is granted organisation-wide. Every other role requires
 * STAFF_BRANCH_CODE, because a branch role with no branch grants nothing and is
 * almost always a mistake.
 */

import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';

const prisma = new PrismaClient();

/* eslint-disable no-console -- a CLI script reports to stdout by design */

const MINIMUM_PASSWORD_LENGTH = 12;

interface Input {
  email: string;
  password: string;
  fullName: string;
  roleName: string;
  branchCode?: string;
}

function readInput(): Input {
  const email = process.env.STAFF_EMAIL?.trim().toLowerCase();
  const password = process.env.STAFF_PASSWORD;
  const fullName = process.env.STAFF_NAME?.trim();
  const roleName = process.env.STAFF_ROLE?.trim().toUpperCase();
  const branchCode = process.env.STAFF_BRANCH_CODE?.trim();

  const missing = [
    ['STAFF_EMAIL', email],
    ['STAFF_PASSWORD', password],
    ['STAFF_NAME', fullName],
    ['STAFF_ROLE', roleName],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (password!.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`STAFF_PASSWORD must be at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }

  if (roleName !== 'OWNER' && !branchCode) {
    throw new Error(
      `STAFF_BRANCH_CODE is required for role ${roleName}. Only OWNER is granted across all branches.`,
    );
  }

  return {
    email: email!,
    password: password!,
    fullName: fullName!,
    roleName: roleName!,
    branchCode,
  };
}

async function main(): Promise<void> {
  const input = readInput();

  const role = await prisma.role.findUnique({ where: { name: input.roleName } });
  if (!role) {
    throw new Error(
      `Role ${input.roleName} does not exist. Run the seed first: npm run prisma:seed`,
    );
  }

  let branchId: string | null = null;
  if (input.branchCode) {
    const branch = await prisma.branch.findUnique({ where: { code: input.branchCode } });
    if (!branch) {
      throw new Error(`Branch ${input.branchCode} does not exist.`);
    }
    branchId = branch.id;
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new Error(
      `A user with that email already exists. This script does not overwrite accounts or reset passwords.`,
    );
  }

  const passwordHash = await hash(input.password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      roles: { create: { roleId: role.id, branchId } },
    },
  });

  // The password is never echoed, and the identifiers printed are the minimum
  // needed to confirm the account was created.
  console.log('Staff account created');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${user.email}`);
  console.log(
    `  role:  ${input.roleName}${branchId ? ` (branch ${input.branchCode})` : ' (all branches)'}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
