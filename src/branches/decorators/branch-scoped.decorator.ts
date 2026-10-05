import { SetMetadata } from '@nestjs/common';

export const BRANCH_PARAM_KEY = 'branch:paramName';

/**
 * Declares that a route acts on one branch, naming where the identifier is
 * found (route param, query string or body field).
 *
 * `BranchAccessGuard` then rejects the request before the handler runs if the
 * actor is not entitled to that branch.
 *
 * @example
 *   \@BranchScoped('branchId')
 *   \@Get(':branchId/orders')
 *   list(\@Param('branchId') branchId: string) { ... }
 */
export const BranchScoped = (paramName = 'branchId') => SetMetadata(BRANCH_PARAM_KEY, paramName);
