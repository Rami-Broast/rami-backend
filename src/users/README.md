# `users/`

Staff-user administration (owner-only). Owns creation, deactivation, password
reset and role grant/revoke for `User` + `UserRole` records.

## Boundary

- Endpoints are owner-only (`users:read` / `users:write` / `roles:assign` —
  each granted only to the OWNER role in `prisma/seed/permissions.ts`).
- Staff users are not branch-owned — the record belongs to the organisation.
  What a user *sees* is scoped by their `UserRole.branchId` grants, not by the
  user row itself. This service does not apply a branch filter on top of the
  permission check.
- Customers are a separate domain (`customers/`); nothing here reads or writes
  the `Customer` table.

## Guarantees

- **Password floor is one place.** The 12-character minimum matches
  `scripts/create-staff-user.ts`, so an operator cannot pick a weaker password
  through the admin UI than through the CLI. The value is
  `MINIMUM_STAFF_PASSWORD_LENGTH` in `dto/user.dto.ts`.
- **No hash ever leaks.** The `userView` selector deliberately excludes
  `passwordHash`, so a change that added it to the response would show up as
  an obvious selector edit rather than a silent leak.
- **Deactivation revokes sessions.** Setting `isActive=false` calls
  `TokenService.revokeAllForActor` for the target, so an already-issued
  refresh token cannot outlive the deactivation.
- **Password reset revokes sessions.** An administrator forcing a new password
  is treated as "the previous credential may be compromised" — the same
  session revocation runs, so an attacker holding a live token is logged out
  immediately.
- **No self-lockout.** An OWNER cannot deactivate themselves, and the last
  active OWNER's OWNER role cannot be revoked. The count is a separate SQL
  query against `User` — a bug in the calling method cannot bypass it.
- **Role grants are validated.** Any non-OWNER role requires a `branchId`
  (matching the CLI's rule). Unknown role or branch id returns 400.
- **Uniqueness is enforced by the DB.** `User.email` is unique, and
  `UserRole` has a unique constraint per `(userId, roleId, branchId)` — the
  service checks first for a friendly 409, but the constraint is the actual
  guarantee against concurrent duplicates.
