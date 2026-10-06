# Rami Broast — Pending work across all six repos

**Audit date:** 2026-08-17
**Phase:** client-demo — every third-party integration waits on client approval and stays mocked until then. See [`DEMO_DECISIONS.md`](./DEMO_DECISIONS.md) for the locked decisions this list is built on.

Legend for each item:
- **[ ] buildable now** — no external decision needed, I can start on your word
- **[ ] needs input** — waiting on credentials or a business decision from the client
- **[×] dropped** — deliberately out of scope

---

## Legend for repo state

| Repo | Purpose | Rough completeness |
| --- | --- | --- |
| `backend` | NestJS + Prisma + PostgreSQL — source of truth | ~85% |
| `admin-app` | Owner + Branch admin, one binary, role-scoped | ~75% |
| `customer-app` | Expo React Native — customer ordering | ~80% |
| `driver-app` | Expo React Native — driver | ~60% |
| `kitchen-pos` | Kitchen screen + POS printer, runs on branch box | ~2% |
| `infrastructure` | Docker, CI/CD, envs, monitoring, backups | ~35% |

---

## 1. `backend`

### Done
Phases 1–8, 11–12, 14 (backend surface), 15 (kitchen backend surface), 16, 17, 18, plus manual accept/reject workflow (`AWAITING_ACCEPTANCE` state + `autoAcceptOrders` toggle + `/orders/:id/accept` + `/orders/:id/reject`).

### Pending — buildable now
- [ ] **`/users` CRUD** — create / list / update / role assignment / branch assignment for staff. Kills `npm run staff:create`.
- [ ] **`/customers` list + search** — search by phone / name, paginated, so the admin app's loyalty page can look up by human, not by UUID.
- [ ] **`/audit` read endpoint** — the `AuditLog` table is already populated; add a filtered read (by actor / entity / date range).
- [ ] **Cash-on-delivery reconciliation** — `POST /deliveries/:id/cash-collected` (amount + variance + note), plus a per-driver / per-shift settlement view.
- [ ] **Order-edit history** — a modify-item endpoint that records `who / why / old / new`, plus a read view. Spec §32.
- [ ] **Driver-performance report** — `/reports/drivers` aggregate: avg time-to-pickup, avg delivery time, deliveries/day per driver. Fills the "avg prep / delivery" tiles the admin dashboard is missing.
- [ ] **WebSocket gateway** — Nest `@WebSocketGateway` emitting `order.awaiting` / `order.transitioned` / `delivery.assigned` / `driver.location`. Kills the 5–8 s admin/customer polling and lets the New Orders tray beep on the exact moment.
- [ ] **Pin mock SMS OTP to `123456`** — small change to `MockSmsSender` so every OTP in the demo is the same known code.
- [ ] **Product `variantId` on `OrderItemInput`** — customer app currently shows size but the backend prices the default; add the field + wire through pricing.
- [ ] **Per-branch printer config** — add `Branch.printerModel` + `Branch.printerConnection` fields so `kitchen-pos` can pick up the right adapter per branch. Small schema change.

### Pending — needs input
- [ ] **Real Tap adapter** — Tap merchant account, sandbox + prod API keys, Apple Pay / mada eligibility confirmation. `TapPaymentGateway` stays a throw-only stub until then.
- [ ] **Real SMS / OTP provider** — vendor choice + credentials (Unifonic / Twilio / etc.). Adapter port already exists.
- [ ] **Real push notifications** — FCM project + APNs cert.
- [ ] **Google Maps** — browser key (admin/customer), Android + iOS keys (driver). **Needed *before* the demo**, not after.
- [ ] **Business inputs** — final branch list, real menu + prices, delivery zones/fees, cancellation/refund policy, loyalty earn rate (`LOYALTY_POINTS_PER_SAR`), VAT treatment of delivery fees.

### Dropped
- [×] **Phase 13 — Invoices + Credit notes + ZATCA.** The restaurant issues its ZATCA invoice separately. No invoice module is to be built.
- [×] **Phase 19 pen-test / hardening** — post-approval launch activity.
- [×] **Phase 20 production deploy** — needs explicit approval.

---

## 2. `admin-app` (Owner + Branch Admin, one binary, role-scoped)

### Done
Login (role-aware), Dashboard, Live Ops (map + KPIs, click-a-pin card, branch filter), New Orders (accept / reject with reason enum + WebAudio chirp), Kitchen queue, Orders list, Order detail (items, snapshot totals, timeline, payment card with tx id, accept/reject/dispatch/cancel actions), Deliveries board (driver assignment, map), Menu (categories + products CRUD + per-branch availability), Payments (list + refunds), Coupons (list + create with typed rules), Loyalty (ledger by ID + adjust), Reports (sales / VAT / payments with date-preset chips), Branch Comparison, Settlements (list + drill-in), Drivers (CRUD), Branch Settings (delivery/pickup/COD/auto-accept toggles + fees), Print (placeholder). Role split: Owner sees all; Branch sees New orders / Kitchen / Orders / Deliveries / Reports / Print.

### Pending — buildable now (paired with backend items above)
- [ ] **Users / staff management page** — needs backend `/users`.
- [ ] **Customer directory page + phone search** — needs backend `/customers`.
- [ ] **Audit log viewer page** — needs backend `/audit`.
- [ ] **Cash reconciliation view** — needs backend cash-collected endpoint.
- [ ] **Order edit history section** on Order detail — needs backend modify endpoint.
- [ ] **Driver-performance report page** — needs backend `/reports/drivers`.
- [ ] **Avg prep / delivery time KPIs** on Dashboard — needs backend aggregate.
- [ ] **WebSocket client** — subscribe once, kill the polls.
- [ ] **Product variant + modifier-group CRUD** in Menu — backend already supports variants at read-time; add write-side.

### Pending — needs input
- [ ] **Google Maps browser key** — Live Ops + Deliveries + Menu-branch pickers fall back to "map unavailable" without it.

### Dropped
- [×] **Invoices / Credit notes tab** — restaurant handles ZATCA.
- [×] **Print settings full UI** — stays placeholder here. Real per-branch printer picker lives in `kitchen-pos` on the branch machine.

---

## 3. `customer-app` (Expo React Native)

### Done
OTP login (phone → OTP), Home (search + promos + categories + popular/recommended rails + offers + order-again), Search, Menu, Product detail (variant + add-ons + notes), Cart (coupon + notes + live server quote), Checkout (delivery/pickup, address, payment-method cards), Payment states (processing / success / failed / retry), Order success, Order tracking (timeline + driver + ETA + map + polling), Orders (active + past + reorder), Offers, Loyalty (**mock**), Account shell, Addresses, Favorites. Design system + motion + animated bottom-tab nav + floating cart.

### Pending — buildable now
- [ ] **Notifications inbox screen** — backend `/customer/notifications` exists, no screen consumes it.
- [ ] **Profile editing** — Account shell rows are placeholders.
- [ ] **Real loyalty wiring** — swap the mock for `/customer/loyalty` (endpoint exists).
- [ ] **Product `variantId` sent on order** — depends on backend field; then send the chosen size.

### Pending — needs input
- [ ] **Google Maps keys** (browser + Android + iOS) — required for tracking map, address picker.
- [ ] **Real Tap payment** — after approval; demo uses mock gateway.
- [ ] **Real SMS OTP** — after approval; demo uses `123456`.
- [ ] **Push notifications** — after approval.
- [ ] **Device QA pass** on real hardware (small / medium / large screens, iOS + Android).

### Dropped
- [×] **Invoice / receipt screen** — restaurant handles ZATCA.

---

## 4. `driver-app` (Expo React Native)

### Done
Login (staff email/password, DRIVER role), Home (online/offline shift toggle, location ping, active job + assignments), Delivery detail (map, Navigate hand-off, correct next action per status, report-a-problem), pure delivery-flow logic mirroring the backend state machine, unit + component tests.

### Pending — buildable now
- [ ] **Proof-of-delivery capture screen** — photo / signature capture, upload, pass URL back to `markDelivered`. `markDelivered` is currently called with `proofType: NONE`.
- [ ] **Earnings + history screen** — spec §15 requires it; only three screens exist today.
- [ ] **Cash-on-delivery confirmation** — collected amount + variance + note, POSTs to the new cash-collected endpoint above.

### Pending — needs input
- [ ] **Google Maps keys** (Android + iOS).
- [ ] **Real push notifications** — after approval.
- [ ] **Privacy-safe customer contact** — call-masking provider (blocked on business input).
- [ ] **Device QA pass** — on real Android + iOS.

### Dropped
- [×] **Nothing dropped explicitly** — everything the driver needs is in scope.

---

## 5. `kitchen-pos` (currently empty — README only)

### Done
- [x] Repo scaffold decisions + README.

### Pending — buildable now
- [ ] **Scaffold** the app (recommend: web + Electron shell or plain web + QZ Tray).
- [ ] **Kitchen-queue screen** — glanceable, new-ticket cue, oldest first. Backend API already exists (`/orders/kitchen/queue`, `/orders/:id/preparing|ready|complete-pickup`).
- [ ] **Per-branch printer picker + adapter loader** — reads `Branch.printerModel` / `Branch.printerConnection` (new backend fields above), loads the matching driver.
- [ ] **Print-ticket + print-docket flows** — kitchen ticket on new order (auto or manual), customer order-summary docket (never an invoice).
- [ ] **Duplicate-print prevention** + **print log** + **printer health / last error**.

### Pending — needs input
- [ ] **Printer models per branch** — one photo or model number per branch printer. Different brands per branch, so we ship an adapter per model as they arrive.

### Dropped
- [×] **Invoice printing** — restaurant issues ZATCA invoice separately.

---

## 6. `infrastructure`

### Done
Backend deploy pipeline (`.github/workflows/deploy-backend-cloudrun.yml` + `scripts/deploy-backend-cloudrun.sh`), deploy docs (backend GCP, admin Vercel, mobile EAS, Google Maps keys), `env/backend.env.example`.

### Pending — buildable now
- [x] **Per-app CI** — `ci.yml` (lint + typecheck + test) added to `admin-app`, `customer-app`, `driver-app`; all three verified green. `kitchen-pos` gets one when scaffolded.
- [x] **Staging environment** — config as code: `env/backend.staging.env.example`, `deploy-backend-staging.yml` workflow, `docs/staging.md` runbook. Standing it up needs a GCP staging project + Cloud SQL instance.
- [x] **Monitoring / alerting / metrics** — `infrastructure/monitoring/*.json` (uptime, 5xx rate, p95 latency, payment/webhook failures) + `setup-monitoring.sh` + `docs/monitoring.md`. Apply needs the GCP project + a notification channel.
- [x] **Backups + tested restores** — `db-backup.sh` / `db-restore.sh` + `docs/backups-and-restore.md`; backup→restore roundtrip tested (row counts preserved). Scheduling needs the GCP project + GCS bucket.
- [x] **Secret management** — `setup-secrets.sh` + `docs/secrets.md`; names in repo, values only in Secret Manager.
- [x] **IaC** (Terraform) — `infrastructure/terraform/` skeleton (Cloud SQL, Secret Manager, GCS, Cloud Run). Not yet `terraform validate`d (no toolchain in dev) — review before apply.

### Pending — needs input
- [ ] **Hosting + domain** — client hosting + domain + go-ahead. Production environment (Phase 20) gated on this.

---

## Suggested demo-day sequence

1. **Client hands over Google Maps keys** — the only external thing needed before the demo.
2. **I pin mock OTP to `123456`** on the backend so the demo audience can always log in.
3. **Customer app pass** — notifications inbox, profile edit, real loyalty wiring.
4. **Driver app pass** — proof-of-delivery, earnings/history, cash-collected confirmation.
5. **Backend + admin-app pass** — users CRUD, customer directory, WebSocket, driver-performance report, cash reconciliation.
6. **Kitchen-pos** — scaffold + kitchen-queue screen (works today; per-branch printer follows once we have models).

After the demo and client approval:
1. Real Tap adapter (once merchant credentials arrive).
2. Real SMS / OTP provider.
3. Real push notifications.
4. Per-branch printer models → matching adapters in `kitchen-pos`.
5. Staging → monitoring → backups → production (Phase 20), gated on approval.
