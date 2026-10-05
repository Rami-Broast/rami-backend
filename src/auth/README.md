# `auth/`

**Status: implemented in Phase 4.**

Authentication and session management.

## What is here

| Path | Purpose |
| --- | --- |
| `auth.controller.ts` | OTP request/verify, staff login, refresh, logout, `me` |
| `auth.service.ts` | Login flows and actor description |
| `services/otp.service.ts` | Code generation, hashing, verification, rate limits |
| `services/token.service.ts` | Access tokens, refresh rotation, reuse detection |
| `services/password.service.ts` | Argon2id hashing and verification |
| `services/actor.service.ts` | Resolves roles, permissions and branch scope from the database |
| `guards/` | Global authentication and permission guards |
| `decorators/` | `@Public()`, `@RequirePermissions()`, `@CurrentActor()` |
| `types/actor.ts` | The `Actor` and `BranchScope` types the whole app depends on |

## Rules this module upholds

- OTP codes are hashed, single-use, expiring, attempt-limited and rate-limited.
  A code is never returned, logged, or stored in plaintext.
- A token identifies a caller; it authorizes nothing on its own. Roles and
  branch scope are resolved server-side on every request, so revocation is
  immediate.
- Refresh tokens are stored only as hashes and rotate on every use. Replaying a
  rotated token revokes the whole family.
- Login responses never reveal whether an account exists.
- No staff account is ever seeded — use `npm run staff:create`.

## Not yet built

Staff user management endpoints (create, update, deactivate, assign roles) are
Phase 4's remaining surface and land with the admin app work. Password reset and
OTP purging need a scheduled job runner.
