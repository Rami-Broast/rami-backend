import { ActorType, AuditOutcome } from '@prisma/client';

import { ActorKind, type Actor } from '../auth/types/actor';
import type { AuditAction, AuditEntity } from './audit-actions';

/**
 * One thing worth recording, as a caller describes it.
 *
 * `before`/`after` are the caller's own snapshots of the entity — never a raw
 * database row grabbed blindly — because the caller is the only one who knows
 * what changed and, crucially, what must *not* be written down. See the
 * account-deletion rule: an audit row for an erasure must not re-store the
 * personal data the erasure just removed.
 */
export interface AuditEntry {
  action: AuditAction;
  entityType: AuditEntity;
  entityId: string;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: AuditOutcome;
  reason?: string | null;
  /**
   * Overrides the actor taken from the request context. Needed for actions that
   * happen on a public route (where the auth guard has not run and there is no
   * ambient actor yet) or attributed to the system.
   */
  actor?: Actor;
  /**
   * Attributes the action to a staff user by id alone, without building a whole
   * {@link Actor}. A staff login is the case: it happens on a public route, so
   * there is no ambient actor, and the only thing known is which user just
   * proved their credentials. Ignored when `actor` is set.
   */
  actorUserId?: string;
}

/** How the actor is stored: the type discriminator and the right foreign key. */
export interface ActorFields {
  actorType: ActorType;
  actorUserId: string | null;
  actorCustomerId: string | null;
}

/**
 * Maps a resolved {@link Actor} onto the audit row's actor columns.
 *
 * With no actor the row is attributed to the system (a scheduled job, a
 * gateway-driven change) rather than dropped — an unattributed action still
 * happened and is still worth a row. `fallback` lets a caller say which flavour
 * of "not a logged-in person" this is (SYSTEM by default; GATEWAY for a
 * webhook-driven change).
 */
export function actorToFields(
  actor: Actor | undefined,
  fallback: ActorType = ActorType.SYSTEM,
): ActorFields {
  if (!actor) {
    return { actorType: fallback, actorUserId: null, actorCustomerId: null };
  }

  if (actor.kind === ActorKind.Staff) {
    return { actorType: ActorType.USER, actorUserId: actor.id, actorCustomerId: null };
  }

  return { actorType: ActorType.CUSTOMER, actorUserId: null, actorCustomerId: actor.id };
}

/**
 * Keys whose values are never written into an audit row, matched
 * case-insensitively at any depth.
 *
 * The `before`/`after` snapshots are built by callers who should already be
 * passing safe fields, but this is defence in depth for the same reason the
 * logger keeps a redaction list: the cost of the filter is nothing, and a
 * credential that reaches an append-only table cannot be taken back out.
 */
const REDACTED_KEYS = new Set(
  [
    'password',
    'passwordHash',
    'currentPassword',
    'newPassword',
    'token',
    'refreshToken',
    'accessToken',
    'otp',
    'otpCode',
    'secret',
    'secretKey',
    'apiKey',
    'privateKey',
    'certificate',
    'card',
    'cardNumber',
    'pan',
    'cvv',
    'cvc',
  ].map((key) => key.toLowerCase()),
);

const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Produces a JSON-safe copy of a snapshot with sensitive values masked.
 *
 * Returns `undefined` for an absent snapshot so the caller can omit the column
 * entirely (leaving a database null) rather than storing an explicit JSON null.
 * Depth is bounded so a pathological or circular structure cannot loop forever.
 */
export function sanitizeSnapshot(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }

  if (depth > 8) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSnapshot(item, depth + 1));
  }

  if (typeof value === 'object') {
    // A Date reads correctly as an ISO string.
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Non-plain objects (notably Prisma.Decimal, which money and rate columns
    // are) must not be walked field by field — that would store their internals
    // rather than their value. Serialise them through their own string form,
    // the same discipline the API uses for Decimal at every read boundary.
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      // Use the object's *own* toString (a Decimal has one), never the base
      // Object.prototype.toString that would yield '[object Object]'.
      const toString = (value as { toString?: () => string }).toString;
      return typeof toString === 'function' && toString !== Object.prototype.toString
        ? toString.call(value)
        : '[UNSERIALISABLE]';
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTION_PLACEHOLDER;
      } else {
        out[key] = sanitizeSnapshot(item, depth + 1);
      }
    }
    return out;
  }

  if (typeof value === 'bigint') {
    // JSON cannot encode BigInt; settlement aggregates cross as strings
    // elsewhere for exactly this reason.
    return value.toString();
  }

  return value;
}
