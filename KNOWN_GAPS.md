# Known gaps — deferred follow-ups

Concrete, ready-to-fix gaps surfaced during implementation. Unlike `PENDING.md`
(the full roadmap) this file is a short list of **specific engineering
follow-ups we have agreed to fix**, each with enough context to pick up cold.

---

## 1. Proof-of-delivery upload is mocked (no object storage)

**Where:** `driver-app/src/proof/proof-upload.ts` (mock adapter behind a stable
`ProofUploader` interface); consumed by `driver-app` `ProofOfDeliveryScreen`.

**State:** `SIGNATURE`/`PHOTO` proof requires a `proofUrl`, which the backend
stores but never produces — "the client uploads the capture elsewhere and passes
back a URL" (see `src/delivery/README.md`). No object-storage provider is
provisioned, so the driver app's uploader is a **mock** that returns a
clearly-marked `mock://proof/...` URL and persists nothing.

**To fix:**
- Provision object storage (S3 / GCS bucket, or Cloudinary) — infra item, needs
  the bucket + credentials via secret management.
- Backend: add a `POST` that mints a short-lived **signed upload URL** (never
  proxy the bytes through the API); return the eventual public/authorized read
  URL shape. Keep it gateway-neutral, same discipline as the payment adapter.
- Driver app: replace the single `proofUploader` binding with the real adapter
  that PUTs to the signed URL. Nothing else in the app changes.
- Consider a max size / content-type allowlist and stripping EXIF GPS from
  photos before upload.

---

## 2. No driver-pay / earnings model

**Where:** `driver-app/src/screens/HistoryScreen.tsx` deliberately shows **no**
monetary earnings; `backend` has no payout/commission model in the schema.

**State:** Per-delivery driver pay (flat fee, per-km, commission, tips) is an
**unset business input**. Inventing a rate would fabricate money figures, so the
History screen shows only the delivery record and the COD cash handled (both
real). This is the same "config not code, confirm before launch" category as the
VAT rate and `LOYALTY_POINTS_PER_SAR`.

**To fix (once the business confirms the pay structure):**
- Decide the model with the client: flat per-delivery, per-km (needs
  `Delivery.distanceKm`, already captured), time-based, commission %, tips, or a
  mix; and who pays it / when it settles.
- Backend: a `DriverEarning` (or ledger, mirroring loyalty) written when a
  delivery reaches `DELIVERED`, with the rate **snapshotted** per delivery so a
  later rate change never rewrites history. Add a driver-facing
  `GET /driver/earnings` (windowed) and a staff payout/report view.
- Driver app: add an earnings summary + per-delivery breakdown to
  `HistoryScreen` from the real endpoint.
