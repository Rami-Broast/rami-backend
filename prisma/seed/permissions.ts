/**
 * Canonical permission codes and the roles that hold them.
 *
 * Format: `<domain>:<action>`. Codes are additive — never reuse or repurpose an
 * existing code once a deployed role grant depends on it.
 *
 * Holding a permission is necessary but never sufficient: branch isolation is
 * applied on top, so a BRANCH_ADMIN with `orders:read` still sees only their
 * assigned branches. That scoping comes from `UserRole.branchId`, not from this
 * list (see Phase 5).
 */

export const PERMISSIONS: Record<string, string> = {
  // Branches
  'branches:read': 'View branch details',
  'branches:write': 'Create and update branches',
  'branches:settings': 'Change branch operating settings',

  // Uploaded artwork (menu photography, offer cards). Owner-level: these bytes
  // live in the database, so who may add them is a bounded question.
  'assets:write': 'Upload images for the menu and offers',

  // Catalog
  'menu:read': 'View categories, products and modifiers',
  'menu:write': 'Create and update categories, products and modifiers',
  'menu:availability': 'Change per-branch availability and price overrides',

  // Orders
  'orders:read': 'View orders',
  'orders:write': 'Create and update orders',
  'orders:cancel': 'Cancel an order',
  'orders:kitchen': 'View and advance the kitchen queue',

  // Customers
  'customers:read': 'View customer profiles and addresses',
  'customers:write': 'Update customer profiles',

  // Payments and refunds
  'payments:read': 'View payments and payment attempts',
  'refunds:read': 'View refunds and customer refund requests',
  /**
   * Decide a customer's refund/cancellation request — approve or decline.
   *
   * Separate from `refunds:write` on the owner's instruction: a **branch**
   * decides whether a customer gets their money back, and the **owner** is the
   * one who moves the money. Reusing `refunds:write` for the decision would
   * have handed every branch manager the direct-refund button on the Payments
   * page as well, which is the opposite of what was asked for.
   */
  'refund-requests:decide': 'Approve or decline a customer refund request',
  'refunds:write': 'Issue refunds and record refunds paid out by hand',

  // Invoicing
  'invoices:read': 'View invoices and credit/debit notes',
  'invoices:write': 'Issue invoices and credit/debit notes',

  // Delivery
  'deliveries:read': 'View deliveries',
  'deliveries:assign': 'Assign a driver to a delivery',
  'deliveries:own': 'View and update own assigned deliveries',
  'drivers:read': 'View driver profiles',
  'drivers:write': 'Create and update driver profiles',

  // Promotions
  'coupons:read': 'View coupons and usage',
  'coupons:write': 'Create and update coupons',
  'loyalty:read': 'View loyalty accounts and ledgers',
  'loyalty:adjust': 'Manually adjust loyalty points',

  // Money and reporting
  'settlements:read': 'View settlements and reconciliation',
  'settlements:write': 'Record and match settlements',
  'reports:read': 'View sales, VAT and payment reports',

  // Charges
  'charges:read': 'View custom charges',
  'charges:write': 'Create and update custom charges',

  // Banners
  'banners:read': 'View advertisement banners',
  'banners:write': 'Create, update and publish banners',

  // Promotions / offers
  'promotions:read': 'View promotions and offers',
  'promotions:write': 'Create, update and publish promotions',

  // The customer docket's template
  'receipt-template:read': 'View the customer receipt template',
  'receipt-template:write': "Change the organisation's customer receipt template",
  'receipt-template:branch': 'Override the receipt template for one branch',

  // Printing
  'printing:sign': 'Have the platform sign this terminal’s print requests',

  // Feature flags
  'features:write': 'Enable and disable feature flags',

  // Customer app config
  'customer-app:write': 'Manage customer app branding, theme and homepage',

  // Administration
  'users:read': 'View staff users and role assignments',
  'users:write': 'Create and update staff users',
  'roles:assign': 'Grant and revoke roles',
  'audit:read': 'View audit logs',
};

/** Canonical system roles. These are seeded and cannot be renamed or deleted. */
export const SYSTEM_ROLES = {
  OWNER: 'OWNER',
  BRANCH_ADMIN: 'BRANCH_ADMIN',
  KITCHEN: 'KITCHEN',
  DRIVER: 'DRIVER',
} as const;

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_ROLES.OWNER]: 'Full access across every branch',
  [SYSTEM_ROLES.BRANCH_ADMIN]: 'Manages a single assigned branch',
  [SYSTEM_ROLES.KITCHEN]: 'Kitchen and order queue for a single assigned branch',
  [SYSTEM_ROLES.DRIVER]: 'Own profile and assigned deliveries only',
};

/**
 * Permissions granted to each system role.
 *
 * OWNER is intentionally listed explicitly rather than granted a wildcard: a
 * new permission should have to be considered and added, not inherited
 * silently.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  [SYSTEM_ROLES.OWNER]: Object.keys(PERMISSIONS),

  [SYSTEM_ROLES.BRANCH_ADMIN]: [
    'branches:read',
    'branches:settings',
    'menu:read',
    'menu:availability',
    'orders:read',
    'orders:write',
    'orders:cancel',
    'orders:kitchen',
    'customers:read',
    'payments:read',
    'refunds:read',
    // The branch decides its own customers' refund requests (owner decision).
    // Moving the money stays owner-only — `refunds:write` is not granted here.
    'refund-requests:decide',
    'invoices:read',
    'deliveries:read',
    'deliveries:assign',
    'drivers:read',
    'charges:read',
    'coupons:read',
    'loyalty:read',
    'reports:read',
    // Branch staff may view their own branch's reconciliation, consistent with
    // their payments/refunds/reports read access. Recording and matching
    // payouts (`settlements:write`) stays owner-only — an organisation-wide
    // payout is owner-only anyway, and matching is a finance-level action.
    'settlements:read',
    // A branch sets what its own kitchen's timings are and what it says to its
    // own customers. The layout, the brand lines and the footer stay the
    // owner's — see BRANCH_OVERRIDABLE_KEYS.
    'receipt-template:read',
    'receipt-template:branch',
    'printing:sign',
  ],

  /**
   * Counter staff at one branch, not just a kitchen screen.
   *
   * This role was scoped to a kitchen *display* — read orders, move them
   * through the queue, mark something sold out. But `kitchen-pos` is the
   * front-of-house POS: the same person takes walk-in orders and hands
   * deliveries to drivers, and every one of those screens answered 403 with
   * "You do not have permission to perform this action" while offering the
   * buttons anyway.
   *
   * Added the four the POS actually calls. All of them stay **branch-scoped**
   * server-side — `branchScopeFilter` / `assertBranchAccess` decide *whose*
   * data, and this list only decides *what*, so a wider list cannot leak
   * another branch's orders or drivers.
   *
   * `reports:read` was added later, on the owner's instruction, and it is the
   * one financial code this role holds. A branch that cannot read its own day's
   * takings has to ring the owner to find out how its own shift went, and the
   * figures are already on the terminal's own screen all day — every order it
   * accepted, with its total. What it buys the counter is the *sum*, which is
   * what an end-of-shift handover is. It stays **branch-scoped** like every
   * other read here: `resolveRequestedBranches` decides whose orders are
   * counted, so this cannot surface another branch's revenue.
   *
   * Deliberately still withheld: `orders:cancel` (a refund-adjacent act that
   * belongs to a branch admin), and the rest of the financial set — payments
   * (the gateway's own records), refunds and settlements.
   */
  [SYSTEM_ROLES.KITCHEN]: [
    'orders:read',
    'orders:kitchen',
    'orders:write', // take a walk-in / phone order at the counter
    'menu:read',
    'menu:availability',
    'branches:read', // resolve which branch this terminal is signed in to
    'deliveries:read',
    'deliveries:assign',
    'drivers:read', // to pick a driver; the customer's phone is never exposed
    // The branch's own sales, VAT and payment totals over a window — the
    // Reports tab in the POS. Branch-isolated server-side like every other
    // read this role holds.
    'reports:read',
    // The POS prints the docket, so it has to be able to read the template it
    // prints. Editing it is not the counter's job and is not granted here.
    'receipt-template:read',
    // …and to have each print signed, which is what stops QZ Tray asking the
    // counter to allow printing every session.
    'printing:sign',
  ],

  [SYSTEM_ROLES.DRIVER]: ['deliveries:own'],
};
