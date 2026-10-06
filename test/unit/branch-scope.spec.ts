import { ForbiddenException } from '@nestjs/common';

import { ActorKind, canAccessBranch, type Actor } from '../../src/auth/types/actor';
import {
  assertBranchAccess,
  branchScopeFilter,
  resolveRequestedBranches,
} from '../../src/branches/branch-scope';

const BRANCH_A = '00000000-0000-7000-8000-00000000000a';
const BRANCH_B = '00000000-0000-7000-8000-00000000000b';
const BRANCH_C = '00000000-0000-7000-8000-00000000000c';

const owner = (): Actor => ({
  kind: ActorKind.Staff,
  id: 'owner-1',
  email: 'owner@example.test',
  fullName: 'Owner',
  roles: ['OWNER'],
  permissions: new Set(['orders:read']),
  branchScope: { kind: 'ALL' },
});

const branchAdmin = (...branchIds: string[]): Actor => ({
  kind: ActorKind.Staff,
  id: 'admin-1',
  email: 'admin@example.test',
  fullName: 'Branch Admin',
  roles: ['BRANCH_ADMIN'],
  permissions: new Set(['orders:read']),
  branchScope: { kind: 'ASSIGNED', branchIds },
});

const unassignedStaff = (): Actor => ({
  kind: ActorKind.Staff,
  id: 'staff-1',
  email: 'staff@example.test',
  fullName: 'Unassigned Staff',
  roles: [],
  permissions: new Set(),
  branchScope: { kind: 'NONE' },
});

const customer = (): Actor => ({
  kind: ActorKind.Customer,
  id: 'customer-1',
  phone: '+966500000000',
  permissions: new Set(),
  branchScope: { kind: 'NONE' },
});

describe('Branch isolation', () => {
  describe('canAccessBranch', () => {
    it('lets an owner reach every branch, including ones they were never told about', () => {
      expect(canAccessBranch(owner(), BRANCH_A)).toBe(true);
      expect(canAccessBranch(owner(), BRANCH_C)).toBe(true);
      expect(canAccessBranch(owner(), 'a-branch-created-tomorrow')).toBe(true);
    });

    it('lets a branch admin reach only their assigned branches', () => {
      const actor = branchAdmin(BRANCH_A, BRANCH_B);

      expect(canAccessBranch(actor, BRANCH_A)).toBe(true);
      expect(canAccessBranch(actor, BRANCH_B)).toBe(true);
      expect(canAccessBranch(actor, BRANCH_C)).toBe(false);
    });

    it('refuses staff with no assignment, rather than treating none as all', () => {
      expect(canAccessBranch(unassignedStaff(), BRANCH_A)).toBe(false);
    });

    it('refuses customers any branch reach', () => {
      expect(canAccessBranch(customer(), BRANCH_A)).toBe(false);
    });
  });

  describe('assertBranchAccess', () => {
    it('permits an entitled branch', () => {
      expect(() => assertBranchAccess(branchAdmin(BRANCH_A), BRANCH_A)).not.toThrow();
    });

    it('throws on another branch', () => {
      expect(() => assertBranchAccess(branchAdmin(BRANCH_A), BRANCH_B)).toThrow(ForbiddenException);
    });

    it('does not reveal whether the branch exists', () => {
      let message = '';
      try {
        assertBranchAccess(branchAdmin(BRANCH_A), BRANCH_B);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }

      // The same wording for a real branch and a fabricated ID, so a branch
      // admin cannot enumerate the organisation by probing.
      expect(message).toBe('You do not have access to this branch.');
      expect(message).not.toContain(BRANCH_B);
    });
  });

  describe('branchScopeFilter', () => {
    it('returns an unrestricted filter only for an owner', () => {
      expect(branchScopeFilter(owner())).toEqual({});
    });

    it('restricts a branch admin to their branches', () => {
      expect(branchScopeFilter(branchAdmin(BRANCH_A, BRANCH_B))).toEqual({
        branchId: { in: [BRANCH_A, BRANCH_B] },
      });
    });

    it('matches nothing for an actor with no branch scope', () => {
      // The critical case. An empty `in` matches no rows; returning `{}` here
      // would hand the whole table to someone entitled to none of it.
      expect(branchScopeFilter(unassignedStaff())).toEqual({ branchId: { in: [] } });
      expect(branchScopeFilter(customer())).toEqual({ branchId: { in: [] } });
    });

    it('never yields an unrestricted filter for a non-owner', () => {
      const nonOwners = [branchAdmin(BRANCH_A), unassignedStaff(), customer()];

      for (const actor of nonOwners) {
        expect(branchScopeFilter(actor)).not.toEqual({});
      }
    });
  });

  describe('resolveRequestedBranches', () => {
    it('falls back to the full scope when no branch is requested', () => {
      expect(resolveRequestedBranches(branchAdmin(BRANCH_A, BRANCH_B))).toEqual({
        branchId: { in: [BRANCH_A, BRANCH_B] },
      });
    });

    it('narrows to a requested branch the actor may reach', () => {
      expect(resolveRequestedBranches(branchAdmin(BRANCH_A, BRANCH_B), BRANCH_A)).toEqual({
        branchId: { in: [BRANCH_A] },
      });
    });

    it('rejects a requested branch outside the actor scope', () => {
      expect(() => resolveRequestedBranches(branchAdmin(BRANCH_A), BRANCH_B)).toThrow(
        ForbiddenException,
      );
    });

    it('rejects a branch request from an owner-less scope even when it exists', () => {
      expect(() => resolveRequestedBranches(unassignedStaff(), BRANCH_A)).toThrow(
        ForbiddenException,
      );
    });

    it('lets an owner narrow to any branch', () => {
      expect(resolveRequestedBranches(owner(), BRANCH_C)).toEqual({ branchId: { in: [BRANCH_C] } });
    });
  });
});
