import { randomInt } from 'node:crypto';

import type { Prisma } from '@prisma/client';

/**
 * Order identifiers.
 *
 * An order carries two customer-visible identifiers, and they do different
 * jobs:
 *
 * - **`orderNumber`** — what staff and the customer say out loud ("order one
 *   million and four"). It counts *per branch* from {@link FIRST_ORDER_NUMBER},
 *   so every branch runs its own series and a branch's number tells its staff
 *   how many orders that branch has taken. It is therefore **not unique across
 *   the platform** — two branches legitimately both have a "1000000" — and it
 *   is sequential, so it is guessable by design.
 * - **`referenceId`** — a globally unique 12-digit random number. Because the
 *   order number is now guessable, this is the handle used to identify one
 *   specific order anywhere on the platform: customer order summary, branch
 *   docket, admin lookup, support call. Random, so it leaks neither the
 *   platform's order volume nor a route to another customer's order.
 *
 * Uniqueness of both is guaranteed by database constraints —
 * `@@unique([branchId, orderNumber])` and `@unique` on `referenceId` — never by
 * an application-level check, which two concurrent requests can both pass.
 */

/** The first order number every branch hands out. */
export const FIRST_ORDER_NUMBER = 1_000_000;

const REFERENCE_MIN = 100_000_000_000; // 12 digits, no leading zero
const REFERENCE_SPAN = 900_000_000_000;

/**
 * Generates one candidate 12-digit reference. Drawn from a CSPRNG: a reference
 * must not be predictable from another order's.
 *
 * The caller inserts it against the unique constraint and, on the rare
 * collision, generates another — there are 9e11 values, so a clash is
 * vanishingly unlikely and cheap to retry.
 */
export function generateReferenceId(): string {
  return `${REFERENCE_MIN + randomInt(REFERENCE_SPAN)}`;
}

/** True when `value` is a well-formed 12-digit reference. */
export function isReferenceId(value: string): boolean {
  return /^[1-9][0-9]{11}$/.test(value);
}

/**
 * Allocates the next order number for a branch, atomically.
 *
 * One statement: insert the branch's counter if it has never taken an order,
 * otherwise increment it, and return the value allocated. Postgres locks the
 * row for the duration, so two concurrent orders in the same branch are
 * serialised and can never receive the same number — the guarantee lives in
 * the database, not here.
 *
 * Must be called with the transaction client that creates the order: if the
 * order rolls back, the allocation rolls back with it and the number is reused
 * rather than lost to a gap.
 */
export async function allocateOrderNumber(
  tx: Prisma.TransactionClient,
  branchId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ allocated: number }[]>`
    INSERT INTO "BranchOrderSequence" ("branchId", "nextNumber", "createdAt", "updatedAt")
    VALUES (${branchId}, ${FIRST_ORDER_NUMBER + 1}, now(), now())
    ON CONFLICT ("branchId") DO UPDATE
      SET "nextNumber" = "BranchOrderSequence"."nextNumber" + 1,
          "updatedAt" = now()
    RETURNING ("nextNumber" - 1)::int AS "allocated"
  `;

  const allocated = rows[0]?.allocated;
  if (typeof allocated !== 'number') {
    // Unreachable: the statement always inserts or updates exactly one row.
    throw new Error(`Could not allocate an order number for branch ${branchId}`);
  }

  return `${allocated}`;
}
