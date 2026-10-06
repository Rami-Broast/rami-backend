import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'auth:permissions';

/**
 * Requires every listed permission code (AND, not OR).
 *
 * Codes are the ones seeded in `prisma/seed/permissions.ts`, e.g.
 * `orders:read`. Holding a permission is necessary but not sufficient — branch
 * isolation is applied on top, so an operator with `orders:read` still only
 * reaches orders in branches they are assigned to.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
