# `zatca-invoicing/`

ZATCA e-invoicing for online orders, **delegated to RestoPOS**.

This backend does **not** implement ZATCA itself — no certificates, no UBL/XML,
no FATOORA submission, no invoice chain. All of that lives in the RestoPOS ZATCA
service (`restopos-zatca-service`). This module is the thin link: it turns an
order into the line items a tax invoice needs, hands them to RestoPOS through one
port, and stores the reference + status + QR of what RestoPOS issued.

This reverses the earlier "ZATCA is out of scope" decision. The client asked
(2026-09-25) for real tax invoices with a QR, issued per order via RestoPOS, and
visible per branch in the admin panel. See `../../DEMO_DECISIONS.md`. The old
markers in `../zatca/README.md` and `../invoices/README.md` still describe the
*native* invoicing that remains unbuilt — that is a different thing from this
delegated integration.

## The rule that governs everything here

**The invoice total must equal, to the halala, the amount the customer was
charged** (`Order.totalMinor`). The platform prices VAT-inclusive and folds
discounts into a strikethrough; a ZATCA line is tax-exclusive with VAT on top. So
a value crosses that boundary in `invoice-lines.ts` (pure, tested), reconciled at
the document level. If the lines ever disagree with the captured total, the issue
is **refused** rather than a wrong tax record written. This module never computes
a payable amount — `VatService` remains the only place that happens.

## Shape (mirrors the payment gateway)

- `restopos-zatca.interface.ts` — the port + neutral types + DI token.
- `mock-restopos-zatca.gateway.ts` — a fully working in-memory adapter for the
  demo and tests. No service deployed, no taxpayer onboarded. It issues fake but
  self-consistent documents (real TLV/base64 QR, a real hash chain, PENDING →
  REPORTED on status read).
- `http-restopos-zatca.gateway.ts` — the real adapter against RestoPOS's
  documented `/external/*` API. Nothing about those endpoints is invented.
- `restopos-zatca.module.ts` — chooses the adapter at boot from `ZATCA_PROVIDER`.
- `zatca-invoicing.service.ts` — orchestration, **best-effort and post-commit**
  like notification dispatch: issuing an invoice can never break placing, paying
  for or refunding an order.
- `invoice-lines.ts` (+ `test/unit/zatca-invoice-lines.spec.ts`) — the pure
  reconciliation.

## Multi-branch

ZATCA requires a separate invoice chain per branch. RestoPOS models that as one
licence + device per chain, so **one Rami Broast branch = one RestoPOS licence +
API key**, grouped under one chain-owner account (single login/bill). The chain
shares the restaurant's one **VAT number**; each branch carries its **own CR** and
address, burned into that branch's certificate. `BranchZatcaRegistration` holds
the per-branch licence; every issue call is scoped to it.

## Config

Off by default (`ZATCA_INVOICING_ENABLED=false`): nothing calls RestoPOS and no
records are written. `ZATCA_PROVIDER=mock` (default) needs no infrastructure;
`restopos` requires `RESTOPOS_ZATCA_BASE_URL` and `PUBLIC_API_URL`.

## Not done in this module (deliberately)

- Wiring into `OrdersService.applyTransition` (issue on captured/CONFIRMED),
  branch creation (provision), and refunds (credit note) — the hooks.
- The inbound status webhook receiver (`/webhooks/zatca`) and a status sweep.
- The admin read endpoint and the client tax-invoice UI.
- **Netting refund VAT in the VAT report.** Credit notes now exist, but
  `reports/` still reports gross output VAT. Changing that is a separate,
  deliberate step — do not assume this module changed it.
