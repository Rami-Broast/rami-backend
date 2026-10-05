# Documentation

| Directory | Contents |
| --- | --- |
| `architecture/` | Decision records and diagrams that expand on the root [ARCHITECTURE.md](../ARCHITECTURE.md). |
| `api/` | API guides for the five client repositories: authentication flows, pagination, error handling, generated OpenAPI artefacts. |
| `payments/` | Tap integration notes, payment/refund state machines, webhook handling, reconciliation runbooks. |
| `zatca/` | ZATCA e-invoicing notes: applicable phase/wave, invoice requirements, onboarding steps. |

Two rules for everything in here:

1. **Never document a credential.** Reference where a value is stored, never its
   value. See [SECURITY.md](../SECURITY.md).
2. **Never document guessed external behaviour.** Tap and ZATCA notes cite
   current official documentation, or they say plainly that the point is
   unconfirmed. An invented tax or gateway rule read as fact by the next
   engineer is worse than a gap.
