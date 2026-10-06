import { ForbiddenException } from '@nestjs/common';

import { Actor, canAccessBranch } from '../auth/types/actor';

/**
 * Branch isolation.
 *
 * The specification's rule is that an owner reaches every branch and everyone
 * else reaches only what they are assigned, enforced server-side on every
 * protected query and mutation. The two helpers here are how that is made
 * structural rather than a thing each endpoint has to remember:
 *
 *   - {@link assertBranchAccess} for a branch named in the request.
 *   - {@link branchScopeFilter} for list queries, producing a Prisma `where`
 *     fragment that cannot be forgotten because the query will not compile
 *     into anything useful without it.
 *
 * Both fail closed. An actor with no branch assignment matches nothing, and
 * never — under any code path here — matches everything.
 */

/**
 * Rejects the request unless the actor may reach `branchId`.
 *
 * The message is deliberately identical to a not-found style refusal in intent:
 * it confirms nothing about whether the branch exists, so a branch admin cannot
 * enumerate the organisation's other branches by probing IDs.
 */
export function assertBranchAccess(actor: Actor, branchId: string): void {
  if (!canAccessBranch(actor, branchId)) {
    throw new ForbiddenException('You do not have access to this branch.');
  }
}

/**
 * A Prisma `where` fragment restricting results to the actor's branches.
 *
 * Returns `{}` **only** for an actor with organisation-wide scope. Every other
 * case produces a real restriction, and an actor with no branches gets a filter
 * that matches nothing rather than one that matches everything — the direction
 * that mistake falls is the difference between an empty list and a full data
 * breach.
 *
 * @example
 *   this.prisma.order.findMany({
 *     where: { ...branchScopeFilter(actor), status: 'PREPARING' },
 *   });
 */
export function branchScopeFilter(actor: Actor): BranchScopeFilter {
  const scope = actor.branchScope;

  switch (scope.kind) {
    case 'ALL':
      return {};
    case 'ASSIGNED':
      return { branchId: { in: [...scope.branchIds] } };
    case 'NONE':
      // `in: []` matches no rows. Chosen over returning `{}` so that a scopeless
      // actor can never accidentally read the whole table.
      return { branchId: { in: [] } };
  }
}

export interface BranchScopeFilter {
  branchId?: { in: string[] };
}

/**
 * Resolves which branches a list request should cover.
 *
 * When the caller names a branch it is validated against their scope; when they
 * do not, the query covers everything they are entitled to. This is the helper
 * for endpoints that accept an optional `?branchId=` filter.
 */
export function resolveRequestedBranches(
  actor: Actor,
  requestedBranchId?: string,
): BranchScopeFilter {
  if (requestedBranchId === undefined) {
    return branchScopeFilter(actor);
  }

  assertBranchAccess(actor, requestedBranchId);

  return { branchId: { in: [requestedBranchId] } };
}
