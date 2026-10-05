# Security

Security rules for this repository, what the foundation already enforces, and
what each later phase must add.

This platform handles payments, personal data and tax records. Rules here are
requirements, not suggestions.

---

## 1. Secrets

**Never commit a secret.** Not a private key, certificate, production
credential, database password, API key or token — not "temporarily", not in a
comment, not in a test fixture.

| Where secrets live | Where they never live |
| --- | --- |
| Secret management (deployment platform / vault) | Git, in any branch |
| A local `.env` (git-ignored) | `.env.example` — names only |
| Runtime environment variables | Source, comments, tests, fixtures |
| Mounted files for certificates | Logs, error messages, API responses |
| | Chat, issues, pull request descriptions |

Enforcement in place:

- `.gitignore` excludes `.env*` (except `.env.example`), `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.crt`, `*.cert`, `*.csr`, `secrets/`, `credentials/` and
  ZATCA certificate paths.
- CI fails if a `.env` file is ever tracked.
- CI runs a secret scan over the full history on every pull request.
- `npm audit --audit-level=high` runs on every pull request.

**If a secret is ever committed:** rotate it first, then clean history. A
rotated credential is safe; a deleted commit is not — it remains in clones,
forks and CI caches.

### Environment separation

Development, staging and production hold **separate credentials for every
integration**. Sandbox Tap keys never reach production; production keys never
reach a developer machine or CI. Production access is restricted and audited.

---

## 2. Authentication and authorization

*(Phases 4–5 — implemented.)*

- Customers authenticate by OTP; staff by email and password.
- **OTP codes are hashed with Argon2id, never stored in plaintext**, and are
  single-use, expiring, attempt-limited and rate-limited. A code never appears
  in a response, a log, or the database.
- Requesting a new code invalidates the previous one, so a resend cannot widen
  the set of codes that work.
- **A token identifies a caller. It does not authorize anything** — roles,
  permissions and branch scope are resolved from the database on every request,
  so revocation is immediate rather than deferred to token expiry.
- Access tokens are short-lived. Refresh tokens are opaque random values stored
  only as SHA-256 hashes, rotated on every use, with **reuse detection**:
  replaying a rotated token revokes the whole session family.
- Passwords are hashed with Argon2id at OWASP-aligned parameters, pinned in
  code so a library upgrade cannot silently weaken them.
- **Login responses never reveal account existence.** A wrong OTP and an unknown
  number return identical responses; a wrong password and an unknown email
  return identical responses, and the unknown-email path deliberately performs
  an equivalent hash verification so timing does not leak either.
- **No staff account is ever seeded.** Accounts are provisioned deliberately via
  `npm run staff:create`, which reads the password from the environment rather
  than a command-line argument.
- The access token signing key is required at boot with a 32-character minimum;
  there is no default, so the app refuses to start rather than fall back to
  something guessable.

### Branch isolation is a security control

| Role | Reach |
| --- | --- |
| `OWNER` | All branches, reports, payments, refunds, settings, user/role management |
| `BRANCH_ADMIN` | Assigned branch only |
| `KITCHEN/POS` | Assigned branch kitchen/order data only |
| `DRIVER` | Own profile and assigned deliveries only |
| `CUSTOMER` | Own account, addresses, orders, invoices, loyalty, coupons |

Enforced on **every protected query and mutation**, server-side, as a guard plus
query scoping — not per-endpoint discipline. See `src/branches/branch-scope.ts`.

An actor with no branch assignment receives a filter matching **nothing**. The
failure direction is deliberate: an empty list is a bug report, whereas the
opposite mistake is a breach.

A hidden button is not access control. Every isolation rule needs a negative
test proving the request fails when made directly: wrong-branch access,
cross-customer access, driver reading an unassigned delivery.

---

## 3. Payment security

- Secret gateway credentials exist **only** on the backend. No client app, no
  branch computer, no POS terminal ever holds one.
- Payments are created and verified server-side.
- **Client-side payment success is never proof of payment.** Only a
  signature-verified webhook or a server-initiated gateway check advances
  payment state.
- Every webhook is signature-verified before it is trusted, and processed
  idempotently — replays and duplicates must not double-apply.
- Payment attempts are modelled separately from orders.
- Refunds validate against the remaining refundable amount and can never exceed
  it.
- Every financial action is audited: actor, action, target, timestamp, outcome,
  gateway reference.
- The platform does not accept, store, process or transmit raw card data. Card
  entry stays with the gateway's hosted mechanisms. Redaction paths for card
  fields exist as a safety net, not as permission.

---

## 4. Logging

Structured JSON with correlation IDs. The redaction list in
`src/logger/logger.module.ts` scrubs authorization headers, cookies, API keys,
gateway signatures, passwords, OTPs, tokens and cardholder fields.

**Never logged:** secrets, tokens, OTPs, passwords, card data, full webhook
payloads containing credentials, database connection strings, or personal data
beyond what an operator needs.

Also enforced:

- The exception filter logs method and path only — query strings are stripped,
  because they carry identifiers and tokens.
- Prisma query logging (which includes bound parameters, meaning customer phone
  numbers and payment references) is **development only**.
- `no-console` is an ESLint error; all output goes through the logger.

**Extend the redaction list whenever a module starts accepting sensitive
input.** A redaction path costs nothing; a leaked OTP in a log aggregator cannot
be recalled.

---

## 5. API security

Enforced by the foundation:

| Control | Implementation |
| --- | --- |
| Security headers | Helmet, verified by e2e test |
| Rate limiting | Global guard; health probes exempt |
| Input validation | Global pipe; unknown properties **rejected**, not stripped silently |
| Body size limit | Configurable, default 1 MB |
| CORS | Closed by default; explicit allow-list only |
| Error messages | Fixed generic text for 5xx; no stack traces, no SQL, no schema names |
| Correlation IDs | Every request and error, for traceable support |
| Framework fingerprint | `x-powered-by` removed, verified by e2e test |
| Authentication | Global guard; `@Public()` is the only opt-out |
| Authorization | Global permission guard; codes seeded, not ad hoc |
| Branch isolation | Global guard plus query scoping helpers |
| OTP endpoints | Tighter per-route limits — each send costs real money |

Rejecting unknown properties matters: it stops a client from smuggling an
undeclared `price`, `role` or `branchId` into a request body.

Additionally: HTTPS everywhere in deployed environments; `TRUSTED_PROXY_HOPS`
must match the deployment or client IPs — and therefore rate limiting and audit
logs — will be wrong.

---

## 6. Data protection

- Personal data is collected only where it serves a function.
- Customer contact from the driver app uses privacy-safe methods (masked
  numbers) rather than exposing raw phone numbers.
- Financial and audited records are soft-deleted, never hard-deleted.
- Invoices and audit logs are retained for the applicable statutory period —
  **to be confirmed, not assumed**.
- Encryption in transit everywhere; encryption at rest for the database and
  backups.
- Backups are tested by restore. An untested backup is not a backup.

---

## 7. Testing requirements

Security properties need tests that prove the failure case, not the happy path.

Already covered:

- 5xx responses never leak the underlying message (including a credential-shaped
  string).
- Prisma errors never leak table or column names.
- Stack traces never reach a client.
- Config validation failures never echo configuration values.
- Oversized correlation IDs are rejected rather than reflected.
- CORS emits no allow-origin header when unconfigured.

Added in Phases 4-5:

- An OTP code is never returned, logged, or stored in plaintext.
- A used, expired, superseded or over-attempted code is refused.
- A rotated refresh token cannot be replayed, and replaying it kills the family.
- Refresh tokens are never stored in recoverable form.
- A deactivated account loses access on the very next request.
- Tokens signed with the wrong key, malformed tokens and non-bearer schemes are
  all refused.
- Wrong-credential and unknown-account responses are byte-identical.
- An actor with no branch assignment matches no rows.
- A non-OWNER role granted without a branch does **not** become organisation-wide.

Required as features land:

- Wrong-branch access is refused at the endpoint level (helpers and guard are
  tested; the endpoints arrive with their phases).
- Cross-customer access is refused.
- Duplicate payment and duplicate webhook are handled idempotently.
- Invalid or excessive refunds are refused.
- A tampered client-side price is ignored in favour of the server total.
- An invalid or expired coupon is refused; a coupon cannot be reused
  concurrently.
- A failed gateway leaves order and payment state consistent.

**Never use real money in tests.**

---

## 8. Dependencies

- `npm audit --audit-level=high` gates every pull request.
- Transitive vulnerabilities are resolved with a scoped `overrides` entry when
  the direct dependency has not yet released a fix (see `package.json`).
- Dependencies are not added silently — a new runtime dependency is a review
  topic.

---

## 9. Deployment

- Container runs as a non-root user (`node`), from a multi-stage build with dev
  dependencies pruned.
- `dumb-init` as PID 1 so `SIGTERM` reaches Node and in-flight requests drain.
- Health checks distinguish liveness from readiness, so a database blip drains
  traffic instead of triggering a restart loop.
- Production access is restricted, monitored and audited.
- Production deploys come only from reviewed, approved code — never from a
  developer machine.

---

## 10. Reporting a vulnerability

Report privately to the repository owner. **Do not open a public issue.**

Include: what is affected, how to reproduce, and assessed impact. Do not include
live credentials in the report — reference where they are stored instead.

---

## 11. Approval gates

The following require **explicit approval** and are never done on an agent's or
developer's own initiative:

- Live payment captures or refunds
- Live ZATCA submissions
- Production database migrations
- Production configuration or credential changes
- Enabling a new payment method
- Any change to branch isolation or authorization logic
