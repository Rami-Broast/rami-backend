# ZATCA e-invoicing documentation

**Nothing is implemented yet — ZATCA integration is Phase 13.**

Before any implementation, these must be confirmed from official sources and
recorded here:

- The restaurant's applicable ZATCA phase and wave.
- Whether clearance or reporting obligations apply.
- Invoice content, numbering, QR and XML requirements for that phase.
- Credit/debit note requirements and their relationship to refunds.
- Certificate onboarding and the required record retention period.

Rules:

- **Do not invent cryptographic, clearance, reporting or certificate details.**
- A PDF carrying a QR image is **not** a compliant e-invoicing solution and must
  never be described as one.
- Certificates and private keys are referenced by storage location only, never
  by value.
- Live submissions require explicit approval.
