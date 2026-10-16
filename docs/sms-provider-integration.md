# Adding a real SMS provider

This is the one code change that lets the platform run as true production
(`NODE_ENV=production`) instead of a hardened closed pilot. Until it lands, the
customer OTP login only works via the pinned demo code `123456` — see
`docs/pilot-deploy.md`.

The seam is already built. OTP and notification code depend on the `SmsSender`
port (`src/notifications/sms/sms.port.ts`), never on a vendor SDK, so adding a
provider touches only the files below — nothing in the auth or notification flow
changes.

## Before writing code (business inputs — do not guess)

- **Provider choice.** Unifonic is the common Saudi-market option; Twilio works
  cross-border. This is a business decision, not an engineering one.
- **Credentials** (API key / sender ID / sandbox + prod), via Secret Manager —
  never committed, never in a GitHub var.
- **Per-message cost** and any sender-ID registration lead time.

Nothing about the chosen provider's API — endpoint, field names, auth scheme —
may be invented. Implement against its current official documentation, the same
rule the Tap adapter follows.

## The change (four edits, mirroring the mock)

1. **Add the enum value** in `src/config/env.validation.ts`:
   ```ts
   export enum SmsProvider {
     Mock = 'mock',
     Unifonic = 'unifonic', // or your chosen provider
   }
   ```

2. **Add the adapter** `src/notifications/sms/unifonic-sms.adapter.ts`,
   implementing `SmsSender` exactly as `MockSmsAdapter` does. It MUST NOT log the
   message body — `SmsMessage.sensitive` marks OTP messages, and an OTP in a log
   is an OTP leaked. Read the provider's credentials from `AppConfigService`
   (add them to `SmsConfig` + `EnvironmentVariables`, validated at boot; add any
   secret to the logger redaction list in `src/logger/logger.module.ts`).

3. **Wire the factory** in `src/notifications/sms/sms.module.ts`. The `switch` on
   `config.sms.provider` is exhaustive on purpose, so adding the enum value
   without a `case` is a **compile error** — follow it:
   ```ts
   case SmsProvider.Unifonic:
     return unifonic;
   ```

4. **Add the production boot guard** in `src/config/configuration.ts`, inside
   `assertProductionPaymentRails` (or a sibling `assertProductionSmsRails` called
   from `buildConfiguration`). The current code deliberately leaves SMS
   unguarded with a comment explaining why — because `mock` is the only value
   today and a guard would fail every production boot for a reason the operator
   cannot act on. Once a real value exists, enforce it:
   ```ts
   if (env.NODE_ENV === Environment.Production && env.SMS_PROVIDER === SmsProvider.Mock) {
     throw new Error(
       'SMS_PROVIDER must not be `mock` when NODE_ENV=production — the mock delivers no sign-in codes.',
     );
   }
   ```
   The production deploy workflow (`deploy-production.yml`) already has a
   matching CI pre-check that refuses `SMS_PROVIDER=mock`; the boot guard is the
   belt to its braces.

## Verify

- A unit test for the adapter: a send returns a `SmsSendResult`, and the body is
  never logged (assert the sensitive-message path logs no body).
- `test/e2e/client-contracts.e2e-spec.ts` already asserts the OTP login flow;
  run it against the provider's sandbox before switching the live var.
- Then set the `SMS_PROVIDER` repo var and deploy through
  `deploy-production.yml`. Retire `deploy-pilot.yml`.
