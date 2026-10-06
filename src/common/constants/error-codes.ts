/**
 * Machine-readable error codes returned to API clients.
 *
 * Clients must branch on these codes rather than on human-readable messages,
 * which are free to change or be localised. Codes are additive — never reuse or
 * repurpose an existing code once an app release depends on it.
 */
export enum ErrorCode {
  // Generic
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

  // Authentication and authorization (implemented in Phase 4/5)
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  BRANCH_ACCESS_DENIED = 'BRANCH_ACCESS_DENIED',

  // Infrastructure
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR = 'DATABASE_ERROR',
}
