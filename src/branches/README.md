# `branches/`

**Status: isolation implemented in Phase 5. Branch CRUD is Phase 5's remaining
surface.**

Branch isolation — the control every other module depends on.

## What is here

| Path | Purpose |
| --- | --- |
| `branch-scope.ts` | `assertBranchAccess`, `branchScopeFilter`, `resolveRequestedBranches` |
| `guards/branch-access.guard.ts` | Validates a branch named in a request against the actor's scope |
| `decorators/branch-scoped.decorator.ts` | `@BranchScoped('branchId')` |

## How to use it

Any query touching branch-owned data must be scoped. Two shapes:

```ts
// A branch named in the request
@BranchScoped('branchId')
@Get(':branchId/orders')
list(@Param('branchId') branchId: string) { ... }

// A list query
this.prisma.order.findMany({
  where: { ...branchScopeFilter(actor), status: 'PREPARING' },
});
```

## Rules this module upholds

- OWNER reaches all branches; BRANCH_ADMIN and KITCHEN reach only assigned
  branches; drivers and customers reach none.
- Scope comes from `UserRole.branchId`, where null means organisation-wide —
  and only for OWNER. A non-OWNER role granted without a branch reaches nothing,
  because that is a provisioning mistake, not a promotion.
- **An actor with no assignment matches nothing, never everything.**
  `branchScopeFilter` returns an unrestricted filter only for an owner.
- Refusals never confirm whether a branch exists, so branches cannot be
  enumerated by probing.

## Not yet built

Branch and BranchSetting CRUD endpoints. The isolation mechanism they will be
protected by is done and tested.
