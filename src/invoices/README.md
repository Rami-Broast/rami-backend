# `invoices/`

**Status: NATIVE invoice models are OUT OF SCOPE. Not built, and not scheduled.**

> **Note (2026-09-25):** Tax invoices *are* now issued — **via the RestoPOS ZATCA
> service** (`../zatca-invoicing/`), which stores its link records in
> `RestoposInvoice`, **not** in the native `Invoice`/`CreditNote` models below.
> Those native models remain unused. See `../../DEMO_DECISIONS.md`.

Native tax invoices and credit/debit notes are **not part of this platform** —
the restaurant issues them through its own systems, or (now) they are issued by
RestoPOS. See `../zatca/README.md` and `DEMO_DECISIONS.md`.

The `Invoice`, `InvoiceLine`, `CreditNote` and `DebitNote` models remain in
`prisma/schema.prisma`. They are **unused**: nothing reads or writes them, and
no module owns them. They are left in place because dropping tables is a
destructive migration with no benefit while they hold no rows — not because
something is coming to fill them.

## One consequence worth knowing

Without a credit-note record, **the VAT report cannot net refunded VAT**. It
reports *gross* output VAT on realised sales and flags itself `basis: "gross"`
so the number is never mistaken for a net figure (`src/reports/reports.service.ts`).

That is now a permanent property of this platform, not a temporary gap. Whoever
prepares the VAT return must net refunds from the restaurant's own invoicing
records, using this report as the gross sales input only.
