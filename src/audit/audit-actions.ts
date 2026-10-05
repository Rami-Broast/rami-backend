/**
 * The catalogue of audited actions and the entity types they target.
 *
 * Every string an audit row can carry lives here rather than being spelled out
 * at each call site, for two reasons: a typo in `'user.role_asign'` would
 * otherwise be invisible until someone filtered for the correct spelling and
 * found nothing, and the set of things the platform audits should be readable
 * in one place rather than reconstructed by grepping.
 *
 * Values are dot-namespaced `entity.verb`. Add to this list when a new action
 * starts recording — do not inline a bare string at the call site.
 */
export const AUDIT_ACTIONS = {
  // Authentication (auth module). Failures are audited too: a burst of
  // `staff.login_failed` for one email is exactly what an owner reviewing an
  // incident is looking for, and it leaves no other trace.
  STAFF_LOGIN: 'staff.login',
  STAFF_LOGIN_FAILED: 'staff.login_failed',

  // Staff administration (users module) — who can reach the platform, and as what.
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_ROLE_ASSIGN: 'user.role_assign',
  USER_ROLE_REVOKE: 'user.role_revoke',

  // Branch lifecycle and configuration (branches module).
  BRANCH_CREATE: 'branch.create',
  BRANCH_UPDATE: 'branch.update',
  BRANCH_STATUS_CHANGE: 'branch.status_change',
  BRANCH_DELETE: 'branch.delete',
  BRANCH_DUPLICATE: 'branch.duplicate',
  BRANCH_SETTINGS_UPDATE: 'branch.settings_update',

  // Refund decisions and payouts (refunds module) — the money path.
  REFUND_REQUEST_APPROVE: 'refund_request.approve',
  REFUND_REQUEST_REJECT: 'refund_request.reject',
  REFUND_ISSUED: 'refund.issued',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** The domain entities an audit row points at. */
export const AUDIT_ENTITIES = {
  AUTH: 'Auth',
  USER: 'User',
  BRANCH: 'Branch',
  BRANCH_SETTING: 'BranchSetting',
  REFUND_REQUEST: 'RefundRequest',
} as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];
