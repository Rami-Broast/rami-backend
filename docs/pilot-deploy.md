# Closed-pilot deploy

The pilot is a real, running backend taking real **COD and pickup** orders for a
**small, hand-onboarded, trusted group of customers** — not the open public. It
exists so the ordering → receiving loop (customer carts, places a COD/pickup
order, branch accepts, kitchen prepares and prints) can run with real branches
before a real SMS/OTP provider is contracted.

Deployed by `.github/workflows/deploy-pilot.yml` (manual, confirmation-gated,
`pilot` GitHub Environment).

## Why it is "staging, hardened", not production

A production boot (`NODE_ENV=production`) **refuses the pinned demo OTP** — the
`resolveDemoFixedCode` guard throws. The pinned OTP (`123456`) is the only
customer login that works until a real SMS provider exists, so the pilot runs
`NODE_ENV=staging` to keep it, and then turns **off** the two demo payment
affordances that a service holding real orders must not expose:

| Variable | Demo (`deploy.yml`) | Pilot (`deploy-pilot.yml`) | Why |
| --- | --- | --- | --- |
| `NODE_ENV` | `staging` | `staging` | keeps the pinned OTP usable |
| `OTP_DEMO_FIXED_CODE` | `123456` | `123456` | only working customer login today |
| `PAYMENT_SANDBOX` | `true` | **`false`** | closes the public "mark any order PAID" endpoint |
| `PAYMENT_MOCK_AUTO_SETTLE` | `true` | **`false`** | no self-settling; an online order would sit PENDING, not be paid for free |
| `PAYMENT_GATEWAY` | `mock` | `mock` | no real card payments; benign if ever hit |
| `SMS_PROVIDER` | `mock` | `mock` | the one thing that must change for production |

Everything else (VAT 15% inclusive, loyalty rate, CORS) matches the other
workflows.

## Accepted risks — these are why the pilot stays closed

1. **The pinned OTP (`123456`) signs anyone in as any phone number.** A stranger
   who knows a customer's number can enter it + `123456` and be in that
   customer's account: their saved addresses, their order history, and the
   ability to place COD orders in their name. This is tolerable **only** while
   the customer set is small, trusted, and hand-onboarded, and the app URL is
   not advertised. **Do not treat the pilot as a soft launch to strangers.** The
   fix is a real SMS provider — see Graduation below.

2. **Clients must offer only COD / pickup (and COD delivery).** No online card
   method may be selectable. The backend does not force this — it is a
   client-side configuration requirement in the customer app and POS checkout.
   If an online method were offered and chosen, with the hardened settings the
   order would sit in `PENDING_PAYMENT` (never confirmed, never charged) rather
   than being marked paid — benign, but a dead end for that customer.

## Operational requirements

- **Separate everything from the demo.** Use a distinct `PILOT_SERVICE_NAME`
  Cloud Run service, a distinct Cloud SQL database, and distinct
  `CLIENT_ORIGINS`. A pilot holding real orders must not share a database with a
  throwaway demo whose orders anyone can mark paid. The workflow refuses to run
  if `PILOT_SERVICE_NAME` is unset or equals the demo's `rami-api`.
- **Keep the pilot URL private.** Hand it to onboarded customers directly; do
  not list it publicly or index it.
- **Staff log in with email + password** (POS, kitchen, admin, driver) — no SMS
  is involved on the staff/receiving side, so branch receiving works fully today.
- **Set a billing budget alert** on the GCP project, as for any Maps key.

## What is NOT needed for the pilot

- **Tap / online card payments** — COD/pickup only. The Tap adapter stays a stub.
- **Object storage** — only needed for photo/signature proof-of-delivery; COD
  delivery can be marked delivered with `proofType: NONE`.
- **Google Maps keys** — delivery navigation/tracking degrade to the written
  address and a "map unavailable" card without them; add for a delivery pilot's
  UX, not required to boot. Not needed for pickup-only.

## Graduation to production

Do this rather than extending the pilot indefinitely — the pinned-OTP risk does
not improve with time.

1. **Add a real SMS provider** — see `docs/sms-provider-integration.md`. This is
   the only code change required; the port and seam already exist.
2. Set the `SMS_PROVIDER`, `PAYMENT_GATEWAY` (→ `tap` once its adapter lands),
   `PUSH_PROVIDER` and the production GCP repo vars/secrets.
3. Deploy through **`deploy-production.yml`** (`NODE_ENV=production`, no pinned
   OTP, payment guards armed).
4. **Delete `deploy-pilot.yml`** — once production is the path, a second
   staging-mode deploy that signs anyone in is a liability, not a convenience.
