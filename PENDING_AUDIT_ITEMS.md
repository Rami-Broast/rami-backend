# Pending audit items

Live tracker for everything the audit found and this branch has **not** closed.
Companion to `SYSTEM_AUDIT_REPORT.md`, which is the point-in-time findings
record; IDs below are that report's IDs.

**Updated:** 2026-09-04 · **Open:** 9 (six needing code, three needing a
decision or hardware) + three optional P3s · **Closed:** 26 ·
**Out of scope:** ZATCA/invoicing

**2026-09-04 — the customer-app work landed on `main`.** The audit branch was
cut from a 17 Aug base and `main` had moved 22 commits past it, including five
new screens and PR #15, which had already fixed the two API-path bugs the
branch also fixed. Merging it would have clobbered that work, so it was ported
onto current `main` piece by piece and reconciled against what `main` already
had — several items were already closed there by other means, and two new
findings came out of the reconciliation (**PEND-28**, **PEND-29** below).

Every item states what is wrong, the evidence it is wrong, the fix, and — the
column that actually governs scheduling — **who can do it**. What remains is
now almost entirely work engineering cannot do alone: credentials, hardware,
and three business decisions.

---

## Closed

| ID | Item | Where |
|---|---|---|
| P1-1 | Customer app called the staff `/branches` (401) | `customer-app` PR #15 (main) — the audit branch's own fix was dropped as a duplicate |
| P1-2 | Customer app stripped the token from `/pricing/quote` (401) | `customer-app` PR #15 (main) — likewise |
| P1-8 | Customer app defaulted to `http://localhost:3000` | `customer-app` main (`16c966a`) |
| **PEND-28** | **A live Maps key was committed to `customer-app/app.json` too** | `customer-app 6332ab3` — **rotation still outstanding, see PEND-01** |
| P0-1 | Live Google Maps key committed | `driver-app ab0c3dc` — **rotation still outstanding, see PEND-01** |
| P1-7 | QZ Tray client never loaded, so printing could not work | `kitchen-pos 9313aac` + engine `b4d3fec` — **hardware unproven, see PEND-03** |
| **P0-2** | **Order transitions not concurrency-safe** | `backend a5eaaac` |
| **P1-3** | **Driver assignment race** | `backend a5eaaac` |
| PEND-27 | e2e fixtures leaked org-wide charges into the integration suite | `backend a5eaaac` |
| **P0-3** | **Fail-open payment sandbox defaults** | `backend 6175f37` |
| **P1-5** | **COD payments never settled** | `backend 02a0dc5` |
| **P1-6** | **No order idempotency** | `backend 5474e15` + both clients (`customer-app 708cd3e`) |
| **P1-4** | **No driver reassignment; deactivation stranded deliveries** | `backend 1715c09` + admin + POS |
| PEND-11 | Drivers visible across branches, including live GPS | `backend 072318c` |
| PEND-12 | No server-side logout | all four apps (`customer-app 88bcd1d`) |
| PEND-13 | Banners / homepage / config never reached the customer app | `customer-app` main (`c4d6509`) — **but the banner is inert, see PEND-30** |
| PEND-16 | Customer app had no error boundary | `customer-app 92d47d5` (root + per screen) |
| PEND-17 | Customer app had no screen tests | `customer-app db93cf0` — all 19 screens |
| PEND-19 | 23 unindexed foreign keys | `backend f8865e3` |
| PEND-21 | No request timeouts in any client | all four apps (`customer-app 836cf54`) |
| PEND-22 | WebSocket reflected any origin | `backend 3927eae` |
| PEND-25 | Redundant `referenceId` index | `backend 3927eae` |
| PEND-14 (part) | No coupon entry for customers | `customer-app` main (cart + Offers screen) |
| PEND-14 (part) | Loyalty, notifications and profile had no UI | `customer-app` main (`fc9b1ae`) — Loyalty, Notifications and Profile screens |
| **PEND-29** | **Checkout priced without the coupon, so the total shown was not the total charged** | `customer-app 708cd3e` |
| **PEND-31** | **The P0-3 fix left the integration and e2e suites red in CI** | `backend` — this branch |
| **PEND-32** | **The concurrency spec's own assertion was flaky (~1 run in 4)** | `backend` — this branch |
| **PEND-33** | **The dependency-audit CI step hangs on the advisory registry** | `backend` — this branch |
| — | Admin panel could not print anything | `admin-app 42b17f3` |
| — | POS printer setup required typing a queue name | `kitchen-pos b4d3fec` |

**Verification:** backend 358 unit + 194 integration + 135 e2e = **687 tests**,
all passing — **now also in CI**, which they were not: see PEND-31. Client apps: admin 47, POS 82, **customer 124** (76 logic + 48
component), driver 29. Every repo builds, typechecks and lints clean.

The concurrency fixes carry their own proof: `test/integration/concurrency.spec.ts`
actually races the calls, and reverting either fix fails four of its six cases.
One of those six was itself flaky at ~25% and has been rewritten — see PEND-32.

---

## ⚠️ Residual actions on "closed" items

These are not finished. They are finished *in code*.

### PEND-01 — Rotate the exposed Google Maps key · ~~**P0**~~ · **DONE 2026-09-04**

**Closed.** The owner rotated it in the Google console on 2026-09-04 at
13:48 GMT+3, via the console's own **Rotate key** flow, which creates the
replacement (`maps-mobile-v2`) and **deletes the previous key** as part of the
same action — the new key's page confirms "the previous key that this key is
rotated from has been deleted".

So `AIzaSyBICLr_…` is revoked. It was live, unrestricted and public from
2026-08-17 to 2026-09-04 — eighteen days. Usage graphs should still be checked
once for traffic in that window that nobody recognises; a dead key does not
undo a bill already run up.

The replacement carries the same API restrictions (Maps SDK for Android + iOS)
and **still has no application restriction**, because no release keystore
exists yet in either app — see PEND-04 for the remaining work. It is at least
no longer published anywhere.

<details><summary>Original entry</summary>


Removing the key from `app.json` does not un-expose it. The key
`AIzaSyBICLr_…` was committed in `ed4023f` and anyone with repository access —
now, or at any point since — has it. Until it is rotated it remains live and
billable.

> **Corrected 2026-09-04 — the exposure was wider than this entry said.** This
> entry recorded the key as a `driver-app` problem whose copy was "out of the
> current file and off main". That was true of `driver-app` and **false of
> `customer-app`**, where the same key was sitting in `app.json` on `main`, in
> the current file, in two places, directly beneath a comment reading "Never
> commit a real key". It arrived in `cbdaf7e` and was found on 2026-09-04 while
> porting the audit branch. It is now removed from that file (`customer-app
> 6332ab3`), but it is in that repo's history too — so **PEND-02's history
> purge covers two repositories, not one.** Rotation was already the only thing
> that actually revokes the key; this makes it more urgent, not less, because
> the key was reachable by more people for longer than recorded.
>
> Check the other four repos before closing this. Two independent commits put
> the same key in two repos, which is the signature of a key being pasted
> wherever it was needed rather than a single slip.

1. Google Cloud console → Credentials → **regenerate** (not delete) the key.
2. Apply **application restrictions**: Android package `com.ramibroast.driver`
   + SHA-1 fingerprint; iOS bundle `com.ramibroast.driver`.
3. Apply **API restrictions**: Maps SDK for Android/iOS only.
4. Set a **billing quota/alert** — an unrestricted Maps key is a known target
   for automated abuse, and the bill arrives before anyone notices.
5. Store the replacement as an EAS secret (`eas secret:create`), never in a file.

**Blocked on:** whoever owns the Google Cloud project. Not an engineering task.
</details>

### PEND-02 — Purge the key from git history · **P3 now** · Engineering + team coordination · 1 h

**Downgraded from P1 on 2026-09-04.** PEND-01 is done, so the string in history
is a **dead key**. This was always cleanup rather than containment once the key
was revoked, and it is now firmly the former: a purge rewrites every commit in
two repositories and forces everyone to re-clone, to remove a credential that
no longer opens anything.

Worth doing only if a future audit re-flagging it would cost more than the
rewrite costs. **Enabling GitHub secret scanning + push protection matters more
than the purge does** and costs nothing — it stops the next one at the door,
which is the failure this pair of commits actually demonstrates.

The key remains in `driver-app` history at `ed4023f` **and in `customer-app`
history at `cbdaf7e`** (see the correction under PEND-01). Both need the same
treatment. Deliberately not done here: history rewriting is coordinated work —
every clone must be re-cloned or reset, and open branches must be rebased — and
doing it silently would break other people's checkouts without warning.

Do it **after** PEND-01, so the window where a stale key is both live and
public is closed first. `git filter-repo --replace-text`, force-push, then have
every holder of a clone re-clone. Consider enabling GitHub push protection /
secret scanning on all six repositories so the next one is blocked at push
time rather than found in an audit.

### PEND-03 — Validate printing against real hardware · **P1** · Client + Engineering · 30 min per branch

**Everything software can do is now done.** The POS has a full print engine
(`kitchen-pos b4d3fec`): **Find printers** asks the machine what it has and
preselects the likely receipt printer, main and kitchen roles with fallback,
retries with backoff, ESC/POS init + cut, paper-width-aware tickets, config
migration, a print log and a duplicate guard. The admin panel prints its own
A4 documents (`admin-app 42b17f3`) and needs no hardware.

What remains is **commissioning, not development**, and it cannot be done
without standing at the counter:

1. Install the **QZ Tray desktop app** on each POS machine. (Separate from the
   JS client, which now ships in the build — that confusion was the original
   bug.)
2. Open Print settings → **Find printers** → confirm the preselected printer →
   **Test main printer**. The test print states the model, the roll width and
   the column count, so a wrong guess is visible on the paper itself.
3. Check the cut. If stray characters print instead, untick **Send ESC/POS cut
   command** — that is the one per-model quirk left exposed as a switch.
4. A **signed QZ connection certificate** per machine. Unsigned, QZ prompts the
   operator on every print, which is unusable during service. This is the one
   item that needs a decision from the client (QZ sells signing certificates;
   self-signed with a trusted local cert also works).
5. Repeat per branch — models differ by brand.

**Blocked on:** physical access to each branch's hardware, plus the certificate
decision at step 4. **Printing remains NOT VERIFIED until a real printer has
produced a real ticket** — the engine is testable, and no test substitutes for
paper coming out.

### PEND-04 — Supply the customer app's Maps key · **P2** · Client/DevOps · 15 min

`customer-app` reads `GOOGLE_MAPS_API_KEY` from the environment now (via
`app.config.js` — before that it was reading a **committed** key, see PEND-28).
As of 2026-09-04 a rotated key exists (`maps-mobile-v2`, PEND-01), so the
remaining work here is **application restrictions**, not the key itself.

**That is blocked on a keystore, not on a decision.** Neither `driver-app` nor
`customer-app` has ever been through EAS Build — no `eas.json`, no `owner`, no
`extra.eas.projectId`, no keystore — so **no release SHA-1 exists to restrict
against**, and an Android application restriction cannot be filled in. The key
is therefore unrestricted-but-private, which is a real improvement on
unrestricted-and-public but is not the end state.

Do it at the first EAS Android build, when a keystore is generated. Two traps
worth carrying: add the **debug** SHA-1 alongside the release one, or maps work
in production and go blank on the developer's own machine; and under Google
Play App Signing the fingerprint that matters is the one in **Play Console →
Setup → App signing**, not the upload key, or maps work in testing and break on
launch day. A billing budget alert is the interim compensating control. Address selection and live order tracking fall back to the "map
unavailable" card. `DEMO_DECISIONS.md` lists the Maps keys as needed *now*
because the demo is meant to show live driver movement. Use a **separate** key
from the driver app's, restricted to the customer bundle identifiers.

---

## P0 / P1 — none remaining in code

Every P0 and P1 engineering finding is fixed and covered by a test. What is
left at those severities is **PEND-01** (rotate the exposed key) and
**PEND-03** (prove printing against real hardware), both above — and neither
is code.

---

## P2 — Should fix

### PEND-15 — Decide the fate of `/promotions` · **P2** · Product + Engineering · 1 h to delete

Seven endpoints and two database models (`Promotion`, `PromotionItem`) with
**no client anywhere** — not admin, not customer. Either build the admin UI or
delete the module. Dead code that looks alive is worse than either, because the
next person to read it assumes the feature exists.

### PEND-18 — `admin-app` test coverage is thin · **P2** · Engineering · 2–3 days

47 tests for ~11k LOC, none covering a page (the "16 tests across 3 files"
figure in an earlier revision of this document was wrong; the summary table's
47 is the correct one). The admin app is
where money is refunded, users are created and branches are closed. At minimum
mount every page against a stubbed API, and cover the refund and user-management
forms.

### PEND-20 — POS and customer app poll instead of using the WebSocket · **P2** · Engineering · 1–2 days

A working authenticated realtime gateway exists — it resolves the actor from the
database on handshake and joins only scope-appropriate rooms — and only
`admin-app` subscribes. `RealtimeService.emitToCustomer` has **no consumer at
all**, so the customer tracking screen polls for updates the server is already
pushing. `kitchen-pos` polls its queues.

Subscribing both removes avoidable load that scales with branches × poll
interval, and makes the new-order cue instant.

---

### PEND-14 — Remaining customer-facing features with no UI · **P3** · Engineering · 2 h

**Mostly closed as of 2026-09-04.** Reconciled against `main`, which had moved
well past the audit branch:

- **Loyalty** — done on `main`: `LoyaltyScreen` reads `/customer/loyalty`.
- **Notifications** — done on `main`: `NotificationsScreen` reads
  `/customer/notifications`.
- **Profile** — done on `main`: `ProfileScreen` reads and `PATCH`es
  `/customer/me`.
- **Coupons** — entry is on `main` (cart + Offers screen); the *pricing* half
  was still broken and is now fixed, see PEND-29.

**Still open — one item:**

- **Address editing** — create and delete exist in the app; `PATCH
  /customer/addresses/:id` exists on the backend and no client calls it, so a
  typo in an address still means delete-and-recreate. Small: one screen and one
  endpoint call.

### PEND-31 — The P0-3 fix left CI red, and the "687 passing" figure was local-only · closed on this branch

Found 2026-09-04 when a documentation-only PR came back with 16 failing tests.

P0-3 changed `PAYMENT_SANDBOX` to default **false**, turning a fail-open default
into a fail-closed one. That is the right change. But nothing then set it for
the test suites, and `simulateWebhook` — the only way a test can drive a payment
to PAID — refuses outright without it. So from that commit onward, 16 tests
across 6 files failed in CI: refunds, loyalty reversal, notifications, payments
and the concurrency spec.

Two things are worth carrying forward from it:

- **It passed locally and failed in CI**, because a developer shell that had
  exported `PAYMENT_SANDBOX` masked it entirely. The audit's own "687 tests,
  all passing" was measured in exactly such a shell. A test-suite prerequisite
  that lives in an environment variable and not in the repository is not a
  prerequisite, it is a coincidence.
- **The failure reads as a payments regression**, not as missing configuration.
  Anyone picking it up cold would start by suspecting the refund logic.

Fixed in `test/setup.ts`, alongside the other test-only env defaults, with
`??=` so a real environment still wins. It does not weaken P0-3: `validateConfig`
refuses the sandbox outright when `NODE_ENV=production`, and that file is loaded
only by jest. Reproduced first (unset the variable → the same 16 failures), then
verified: 358 unit + 194 integration + 135 e2e green with nothing exported.

### PEND-32 — The concurrency spec was flaky, in the one place flakiness is least affordable · closed on this branch

Found immediately after PEND-31, once the suite could run in CI at all.

`never lets an order be confirmed and cancelled at the same time` asserted that
a CANCELLED outcome must have `preparingAt` null — i.e. that only one of its six
racing calls could ever win. That is not what the P0-2 fix guarantees, and it
should not be: `PREPARING -> CANCELLED` is a legal edge, so a correctly-locked
run can legitimately serialise two calls — one moves CONFIRMED -> PREPARING, a
later one moves PREPARING -> CANCELLED. `preparingAt` set on a cancelled order
is then accurate history (it really was being prepared when it was cancelled),
not corruption.

Reproduced at **2 failures in 8 local runs**, ~25%. This is the worst possible
place for a flake: the message reads like a locking bug in the exact fix the
test exists to defend, so every failure invites someone to go looking for a
race that is not there — or, worse, teaches the team to re-run this suite until
it is green, which is how a real regression gets waved through.

Rewritten to assert the invariant that actually separates the fix from the bug:
the status history is one unbroken chain (each move starts where the last one
ended, and the last agrees with the order row), no status is entered twice, and
exactly one move leaves CONFIRMED. A writer that committed against a stale read
breaks the chain.

**Strictly stronger than what it replaced**, and verified both ways: 14/14 green
with the fix in place, and **5/5 red with the P0-2 guard reverted** — failing on
the chain assertion with `Expected: "PREPARING", Received: "CONFIRMED"`, which
is the corruption itself. The old assertion managed only ~75% green with the fix.

### PEND-33 — The dependency audit fails intermittently on the registry, not on a finding · closed on this branch

The third CI failure found once the suites could run at all, and the clearest
of the three because the evidence is a controlled experiment nobody set up.

Commit `20ff550` triggered the `security` job **twice**. The two runs disagreed
on identical input: one passed in two minutes, the other hung for eleven and
exited `code undefined:` with no advisory named. `npm ci` in the same job
reported "found 0 vulnerabilities" both times. So the dependency tree was not
what differed — `audit-ci` queries the advisory registry itself, and that call
intermittently never returns.

Reproduced locally, and the measurement settles it: **4m40s wall clock for
0.377s of CPU** before a timeout killed it, with no output at all. A process
that burns four tenths of a second of CPU over four and a half minutes is not
analysing a dependency tree — it is blocked on a socket. `npm audit` against
the same lockfile answered instantly with "found 0 vulnerabilities".

A red check that means "the registry was slow" is worse than no check: it
teaches everyone to re-run the security job on sight, which is the habit that
waves a real advisory through.

**First fix was wrong, and the correction is the interesting part.** Three
attempts with a 120s timeout each assumed the hang was intermittent. It is not:
the very next run failed all three attempts, each timing out at exactly 120s
with no output, and so did its duplicate. `audit-ci` is pinned at ^7.1.0 and
installed by `npm ci` — not an unpinned-`npx` problem — so the tool genuinely
does not complete against the advisory endpoint from these runners.

A retry cannot fix a durable outage, and no swap of one tool for another is
better than a coin flip while the endpoint is the shared cause.

So the gate no longer branches on an exit code that conflates "vulnerable" with
"unreachable". `scripts/audit-gate.sh` asks once with a deadline and branches on
whether it got **data**: a report naming high or critical advisories fails the
build and lists them; a clean report passes; no parseable report at all emits a
loud warning and passes. That last case is a deliberate trade and the reason
**Dependabot alerts should be enabled on the repository** — GitHub evaluates
those, not a runner with egress problems, so they still catch what this step
misses on a bad day.

All four branches are verified against fixtures (clean, finding, empty, and a
502 returning HTML), through a documented `AUDIT_SKIP_FETCH` seam — the three
branches are the entire point of the script and are untestable if the fetch
always overwrites the report first.

`audit-ci.jsonc` is kept for its recorded assessment but is no longer read; its
single allowlist entry is moot, since the npm overrides in `package.json`
resolve GHSA-ggr8-5vv4-36mx and `npm audit` reports zero vulnerabilities.

### PEND-30 — An admin banner reaches the customer but does nothing · **P3** · Engineering · 2–4 h

Found 2026-09-04 while writing the customer app's screen tests. A banner
published in the admin panel does now reach the home screen (`BannerCarousel`,
from `/customer/config`), which was PEND-13's whole point — but it renders as a
bare `Image` and nothing else:

- `title`, `description` and `buttonText` (and their `*Ar` twins) are never
  drawn. Every word of a banner has to be baked into the image, which means no
  Arabic banner without a second image, and nothing legible to a screen reader.
  It now carries an `accessibilityLabel` from `title` — the minimum that makes
  it perceivable and testable — but that is a label, not a design.
- `action`, `targetId` and `targetUrl` go nowhere. The banner is not tappable,
  so "20% off — order now" leads to no order. That is the entire commercial
  point of a banner.

Either wire the action and render the text, or drop those fields from the model
so nobody publishes a call-to-action that cannot be called. Recorded rather
than fixed in place, because deciding what a banner looks like and where each
`action` goes is a product decision, not a test fix.

## P3 — Optional

| ID | Item | Effort |
|---|---|---|
| PEND-23 | `GET /orders?limit=25` returns **92 KB**; the list serialises full nested item detail. Add a summary projection. | 2–3 h |
| PEND-24 | `admin-app` ships a 456 KB single bundle (125 KB gzipped), no code splitting. | 2–4 h |
| PEND-26 | No response caching anywhere; the branch menu is the obvious candidate. | 4–6 h |
| PEND-27 | **The e2e suite leaves active org-wide charges behind, which then break the integration suite.** `Charge` rows with `branchIds: null` apply to *every* order, and the e2e fixtures create them without cleanup. Running `test:integration` after `test:e2e` on the same database fails 17 pricing assertions — orders cost more than expected — which reads as a pricing regression and is not one. Found while re-running the suites during this work: clean database 172/172, reused database 155/172. Either clean up org-wide fixtures, scope them to a test branch, or have the pricing tests assert against a charge-free baseline. | 2–3 h |

---

## Out of scope — do not build, do not schedule

### ZATCA e-invoicing, tax invoices, credit notes and the invoice QR

**Removed from this platform entirely.** Decided by the client on 2026-08-17
(`DEMO_DECISIONS.md`) and reaffirmed on 2026-09-03: skip it fully, including the
QR code and anything related to it. The restaurant issues its own ZATCA invoice
to the customer through its own systems.

This platform surfaces order information only — order number, reference, items,
totals, VAT and payment status. It must never produce a tax invoice, a credit
note, an invoice QR code, a UBL/XML document or a ZATCA submission.

**Correction to the audit report.** `SYSTEM_AUDIT_REPORT.md` listed ZATCA as a
production blocker and a legal requirement, and scored it 0%. That framing was
wrong, and it is the kind of error that distorts planning, so it is corrected
here rather than left standing. The legal obligation belongs to the restaurant,
not to this software, and the restaurant meets it through a separate system.
A platform that does not issue tax invoices has no ZATCA obligation to fail.
Scoring an out-of-scope capability at 0% and averaging it into the total also
understated the platform. ZATCA is now excluded from scoring rather than scored
zero.

**Current state of the code — nothing to remove.** No ZATCA or invoicing code
has ever run: `src/zatca/` and `src/invoices/` are README-only and are not
imported by `AppModule`; a search for QR, TLV or ZATCA logic outside those two
directories returns nothing. The two READMEs have been rewritten from "scheduled
for Phase 13" to "out of scope", so the next person to read them does not build
it by mistake, and `CLAUDE.md` no longer lists Phase 13 as blocked work.

The `Invoice`, `InvoiceLine`, `CreditNote` and `DebitNote` models remain in
`prisma/schema.prisma`, unused. Dropping them is a destructive migration with no
benefit while they hold no rows, so they are left alone deliberately.

**One consequence to carry into accounting.** Without credit notes, the VAT
report is **gross output VAT only, permanently** — it cannot net VAT returned by
refunds. It flags itself `basis: "gross"` so the figure is never mistaken for
net. Whoever prepares the VAT return must net refunds from the restaurant's own
invoicing records and use this report as the gross sales input only. That is now
a standing property of the platform, not a gap awaiting a later phase.

---

## Blocked on the client — start these now

Nothing on this list can be closed by engineering alone, and several gate
production entirely. They have the longest lead times, so they should be
initiated before the P0 work rather than after it.

| Item | Blocks | Needed from the client |
|---|---|---|
| **Tap payments (Phase 11)** | Any real card payment | Merchant account, sandbox + production credentials, Apple Pay / mada eligibility. The interface and a working mock exist; the Tap adapter is an explicit stub that throws. Never to be guessed from unofficial sources. |
| **Google Maps keys** | Live tracking in the demo | Two restricted keys (driver, customer). See PEND-01, PEND-04. |
| **Object storage** | Proof of delivery, all image upload | A bucket + credentials. There is **no upload endpoint anywhere** (`FileInterceptor`/`multer`: 0 hits); banner and product images are free-text URL fields with no validation. §36 is unmet. |
| **Printer hardware** | Real printing | Per-branch make/model, physical access, and a decision on QZ connection signing. The software side is complete — see PEND-03. |
| **SMS / push providers** | Real notifications | Provider + credentials. Mock adapters work end to end today. |
| **VAT treatment confirmations** | Correct tax on live orders | Accountant sign-off on VAT-inclusive pricing, delivery-fee taxability, and discount-vs-VAT ordering. The rate (15%) is confirmed; these three are assumptions in config. |
| **Refund policy** | Refund operations | Window, partial rules, who authorises. |
| **Loyalty earn rate** | Loyalty launch | `LOYALTY_POINTS_PER_SAR` defaults to 1 — a placeholder, explicitly to be confirmed. |
| **Driver pay model** | Driver earnings screen | Flat/per-km/commission/tips, and who pays when. No payout model exists in the schema; the History screen deliberately shows no money rather than inventing a figure. |

---

## Suggested sequence

**1 — This week, and only you can do these**
- **PEND-01** — rotate the Maps key. 15 minutes, and it is live and billable
  until you do. Note the correction under that entry: the key was exposed in
  **two** repositories, not one, so it has been reachable by more people for
  longer than this document previously said.
- Start every client-blocked item below. Lead times, not effort, are the risk.
- **PEND-04** if the demo is imminent.

**2 — When someone can stand at a counter**
- **PEND-03** — install QZ Tray per machine, run Find printers, test print,
  check the cut. Plus the one decision on connection signing.

**3 — Housekeeping, whenever**
- **PEND-02** — purge the key from history, after PEND-01. **Two repositories**
  (`driver-app` and `customer-app`), and check the other four first.
- **PEND-15** — decide whether `/promotions` gets a UI or gets deleted.
- **PEND-30** — decide what a banner does when tapped, or drop the fields.
- **PEND-18**, **PEND-20**, and the remaining P3s.

**4 — Before real money moves**
- Tap integration, once credentials exist.
- The Phase 19 pre-production hardening and penetration test, which is the
  right place to re-run everything in this document.

---

## What the audit could not test

Stated so nothing here is mistaken for a clean bill of health. **Not performed:**
load and stress testing; penetration testing; real gateway or ZATCA integration
testing; physical printer testing; iOS/Android device testing; any verification
against a production environment. Performance figures in the audit report are
smoke measurements against a small dataset, not load-test results.
