# `zatca/`

**Status: NATIVE ZATCA is OUT OF SCOPE. Not built, and not scheduled.**

> **Note (2026-09-25):** ZATCA e-invoicing *is* now delivered — but **delegated
> to the RestoPOS ZATCA service**, not built natively here. See
> `../zatca-invoicing/` and `../../DEMO_DECISIONS.md`. This directory remains the
> marker for the *native* build described below, which is still not built. The
> two are different: the delegated integration stores only a reference to what
> RestoPOS issued; it does not produce a UBL/XML document or submit to FATOORA
> from this backend.

ZATCA / Fatoora e-invoicing is **not part of this platform**. The restaurant
issues its own ZATCA invoice to the customer through its own systems. This
backend surfaces order information only — order number, reference, items,
totals, VAT and payment status — and never produces a tax invoice, a credit
note, an invoice QR code, a UBL/XML document or a ZATCA submission of any kind.

Confirmed by the client on 2026-08-17 (`DEMO_DECISIONS.md`) and reaffirmed on
2026-09-03. Any specification text pointing at "Phase 13" should be read as
"the restaurant does this separately".

**Do not build any of it here, and do not add a QR code to a ticket, docket or
screen on the assumption that it helps.** A QR image is not a compliant
e-invoicing artefact, and an invoice-shaped document issued by a second system
creates duplicate tax records rather than compliance.

## If this is ever brought back into scope

It is a full project, not a module: it needs the restaurant's legal name, CR
number and VAT registration; its applicable ZATCA phase/wave; whether it is
under clearance or reporting obligations; onboarding certificates and private
keys through secret management; and implementation strictly against current
official ZATCA technical documentation. None of it may be inferred or guessed.

This directory is kept as the marker for that decision. It contains no code.
