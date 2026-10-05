import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is applied globally, so this is the *only* way to open a
 * route — which means every unauthenticated endpoint is visible as an explicit,
 * greppable decision in review, rather than an endpoint someone forgot to
 * protect.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
