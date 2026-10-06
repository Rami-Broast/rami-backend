# Demo accounts — how to seed them

Four apps, three account types, one backend. This page explains exactly how
each account is created for the client demo and what credentials each app
accepts. It is the operational companion to `DEMO_DECISIONS.md`.

## Account model (from spec §0 and §4)

- **Customers** self-create by phone + OTP. The customer app is the only place
  a customer account is ever created — there is no admin-side "add customer"
  form for signup. On the demo the OTP is always `123456`.
- **Staff** (Owner, Branch Admin, Driver) are never seeded and cannot self-sign
  up. Every staff account is created by a human with sufficient permission:
  - The **first Owner** is created directly on the backend host via
    `npm run staff:create` (the password is read from an environment
    variable, never from a command-line argument, so it does not appear in
    shell history or process listings).
  - **Every subsequent staff account** is created by an Owner from the Admin
    app's **Users** page. Branch Admins can create Drivers for their own
    branch.
- **Branches** are created by an Owner from the Admin app's **Branches** page.

This is a deliberate security posture: hiding a control in a client app is
not access control (spec §0 rule 4), so the backend refuses to seed a
password-holding account under any circumstance.

## Which app takes which role

| App | Auth endpoint | Accepted roles |
| --- | --- | --- |
| customer-app | `POST /auth/customer/request-otp` → `POST /auth/customer/verify-otp` | Customer (self-created) |
| admin-app | `POST /auth/staff/login` | OWNER, BRANCH_ADMIN |
| kitchen-pos (Branch POS) | `POST /auth/staff/login` | BRANCH_ADMIN |
| driver-app | `POST /auth/staff/login` | DRIVER |

The backend decides what each role can see; the client app is only a view of
that permission set. A Branch Admin signing into the admin app sees the
branch-scoped subset of pages; a Driver signing into the admin app is
rejected.

## Bootstrapping the demo — order of operations

1. **Owner** — you (the platform owner) supply the credentials.
   ```bash
   # on the backend host (Cloud Run job or `gcloud run jobs execute`, or
   # locally against a staging database)
   STAFF_EMAIL='owner@rami.example' \
   STAFF_PASSWORD='<a strong password you set>' \
   STAFF_NAME='Owner' \
   STAFF_ROLE=OWNER \
     npm run staff:create
   ```
   The password comes from the environment, never a CLI argument. Do not
   commit it, do not paste it into chat.
2. **Branches** — sign into the admin app as the Owner and create each
   branch under **Branches**. Each branch carries its own settings (COD
   allowed, auto-accept orders, delivery zones, etc.).
3. **Branch Admins** — for each branch, create a `BRANCH_ADMIN` user under
   **Users** and assign them to that branch. Hand those credentials to the
   branch's point-of-sale operator; they sign into the Kitchen POS with them.
4. **Drivers** — create `DRIVER` users under **Drivers** (owner) or **Users**
   (Owner and, for their own branch, Branch Admin). Hand those credentials
   to the delivery driver; they sign into the driver app with them.
5. **Customers** — nothing to seed. Customers register themselves via the
   customer app: enter phone, receive OTP (`123456` on the demo), verify.

## Where each app is deployed for the demo

All four apps point at the same live backend
(`https://rami-api.example.com/api/v1`) so signing in on one
carries over to actions the others see in real time (order fires on the POS
the moment a customer places it, the driver app lights up the moment a
dispatch happens, and so on).

| App | Web preview |
| --- | --- |
| customer-app | Vercel deploy (Expo web export, SPA) |
| admin-app | Vercel deploy (Vite) |
| kitchen-pos | Vercel deploy (Vite) |
| driver-app | Vercel deploy (Expo web export, SPA) |

Native iOS/Android builds for the customer and driver apps go through EAS
Build once your Apple Developer + Google Play accounts are wired in; that is
gated on client approval (see `DEMO_DECISIONS.md`).

## Rules that hold across all four apps

- The customer app **displays** totals; it never computes them. Every price
  comes from a backend-snapshotted breakdown.
- No app stores a payment credential. Cash-on-delivery is enabled per branch.
- Client-side "payment success" never proves payment — only a
  signature-verified webhook (or a server-initiated gateway check) does.
- Every branch-scoped query is enforced server-side by
  `branchScopeFilter(actor)` / `assertBranchAccess`. A client that "hides" a
  control does not substitute for that.
- No secrets in the repo — Cloud Run reads them from Secret Manager, Vercel
  reads them from project env vars, EAS reads them from EAS Secrets.
