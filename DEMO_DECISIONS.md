# Client demo — locked decisions

**Read this before doing anything that touches payments, invoicing, SMS, push,
maps or printing.** These are the client's answers as of 2026-08-17, standing
for every repo in the platform. Do not re-litigate.

## We are building for a demo, not for production

Everything in this session and the ones that follow is for a **client demo**.
The client will approve or reject after seeing it work. Only after that
approval do we integrate real credentials for any of the paid or third-party
integrations below. Nothing here means "cut corners" — it means "wire against
a working mock behind the same interface the real thing will use, so swapping
in the real credentials later is a one-file change, not a rewrite".

## What we do NOT build

- **Invoices + credit notes (Phase 13, ZATCA)** — **dropped from scope
  entirely. Reaffirmed by the client on 2026-09-03: skip it fully, including
  the invoice QR code and anything related to it.** The restaurant issues its
  ZATCA invoice to the customer through its own systems. We only surface the
  online-order info (order number, items, totals, payment status). No
  `Invoice` module, no `CreditNote` module, no ZATCA integration is to be
  built. Any spec text pointing at Phase 13 should be read as "restaurant
  does this separately".

  > **REVERSED 2026-09-25 — ZATCA is back in scope, via RestoPOS (not native).**
  > The client asked for real tax invoices with a QR, issued per order by the
  > RestoPOS ZATCA service, visible per branch in the admin panel and shown to
  > the customer as a digital tax invoice. We still do **not** build native
  > ZATCA in this backend — we *delegate* to RestoPOS over its external API and
  > store only the reference/status/QR. See `src/zatca-invoicing/`. Consequences
  > being worked through: the customer/admin surfaces must now say **"This is a
  > tax invoice"** (the old "not a tax invoice" stamps are removed), and refunds
  > issue ZATCA **credit notes**. The native `src/zatca/` and `src/invoices/`
  > markers still stand for the *native* build, which remains unbuilt.
  > Production issuance still needs the restaurant's real VAT/CR + per-branch
  > FATOORA onboarding and stays gated on approval; the demo runs on the mock.

## What waits for client approval (mock now, real later)

Each one lives behind an interface with a working mock adapter so the demo
runs end-to-end. Swap the adapter on the day the credentials arrive.

- **Tap Payments (real gateway)** — `MockPaymentGateway` powers the demo with
  signed webhooks. `TapPaymentGateway` stays a throw-only stub until real Tap
  merchant credentials + Apple Pay/mada eligibility are confirmed.
  On the demo, `PAYMENT_MOCK_AUTO_SETTLE=true` makes the mock gateway deliver
  its own signed success webhook the moment a charge is created, so an online
  order completes and reaches the branch. Without it nothing ever settles a
  mock charge — there is no hosted page and no bank behind it — and every
  online order sits in PENDING_PAYMENT for ever, invisible on the POS. The flag
  is off by default and is meaningless outside the sandbox; when Tap's adapter
  lands, the real gateway's webhook does this job and the flag goes off.
- **SMS / OTP provider** — customer login uses a **fake demo OTP**. The
  provider port stays behind the interface; swap in the real vendor
  (Unifonic / Twilio / etc.) once picked.
- **Push notifications** — mock adapter for the demo. Real FCM/APNs after
  client approval and app-store setup.

## What we need from the client NOW (before the demo)

- **Google Maps API keys** — needed for the demo so the real-time driver map,
  delivery destinations and address selection all render correctly:
    - Browser key (customer app, admin app)
    - Android key (driver app)
    - iOS key (driver app, when we go there)

## What is per-branch, not one-size-fits-all

- **Printer / POS integration** — **every branch has a different brand of
  thermal printer**. The integration is per-branch: the branch chooses its
  printer model, we ship the matching adapter (QZ Tray or a per-model
  driver). Never assume one printer everywhere; store the model + connection
  on the branch and load the right adapter at runtime. This is why
  `kitchen-pos` is a separate app — it runs on the branch machine that owns
  the printer, and the backend never talks to a printer directly.

## Fake OTP for the demo — how it works

For every customer login OTP request during the demo, the "sent OTP" is
always **`123456`**. The mock SMS sender logs the code as it would for any
provider, but the fixed value means a demo audience with no phone can still
log in as a customer on the spot. This lives entirely in the mock adapter —
the OTP verification code path in `AuthService` is unchanged, so switching
to the real SMS provider needs no logic changes.

## When these decisions change

Update this file. Every repo's CLAUDE.md points here — one source of truth
for what's demo vs. production.
