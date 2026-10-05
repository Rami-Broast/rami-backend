/**
 * Who is making a request, and what they may reach.
 *
 * Resolved from the database on **every** request rather than read out of the
 * access token. That costs a query, and buys the property that revoking a role
 * or a branch assignment takes effect immediately instead of whenever the
 * holder's token happens to expire. For an application that manages money and
 * multi-branch access, that trade is the right way round.
 */

export enum ActorKind {
  Staff = 'STAFF',
  Customer = 'CUSTOMER',
}

/**
 * Which branches an actor may reach.
 *
 * Modelled as a discriminated union rather than a nullable array so that "all
 * branches" and "no branches" can never be confused with one another — an empty
 * array meaning "everything" is exactly the kind of bug that silently unlocks a
 * whole organisation.
 */
export type BranchScope =
  /** OWNER. Every branch, including branches created after this grant. */
  | { kind: 'ALL' }
  /** BRANCH_ADMIN / KITCHEN. Only the listed branches. */
  | { kind: 'ASSIGNED'; branchIds: readonly string[] }
  /** Customers and drivers: no branch-management reach at all. */
  | { kind: 'NONE' };

export interface StaffActor {
  kind: ActorKind.Staff;
  id: string;
  email: string;
  fullName: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
  branchScope: BranchScope;
}

export interface CustomerActor {
  kind: ActorKind.Customer;
  id: string;
  phone: string;
  /** Customers hold no permissions; they reach their own records only. */
  permissions: ReadonlySet<string>;
  branchScope: { kind: 'NONE' };
}

export type Actor = StaffActor | CustomerActor;

export function isStaff(actor: Actor): actor is StaffActor {
  return actor.kind === ActorKind.Staff;
}

export function isCustomer(actor: Actor): actor is CustomerActor {
  return actor.kind === ActorKind.Customer;
}

/** True when the actor may reach the given branch. */
export function canAccessBranch(actor: Actor, branchId: string): boolean {
  const scope = actor.branchScope;

  switch (scope.kind) {
    case 'ALL':
      return true;
    case 'ASSIGNED':
      return scope.branchIds.includes(branchId);
    case 'NONE':
      return false;
  }
}
