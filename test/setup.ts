// Decorators from class-validator, class-transformer and Nest all rely on the
// metadata reflection polyfill. main.ts imports it at runtime; tests import the
// decorated modules directly, so they need it loaded first too.
import 'reflect-metadata';

// Test-only configuration. These are throwaway values for an ephemeral test
// database and process — never real credentials, and never used outside tests.
// A deployed environment injects its own through secret management.
process.env.JWT_ACCESS_SECRET ??= 'test-only-signing-key-not-a-real-secret-000';
process.env.OTP_RESEND_COOLDOWN_SECONDS ??= '0';
process.env.OTP_MAX_REQUESTS_PER_HOUR ??= '100';

// The payment sandbox, which the integration and e2e suites need in order to
// drive a payment to PAID at all — `simulateWebhook` refuses outright unless
// `PAYMENT_SANDBOX` is on and the gateway is the mock.
//
// It has to be set here rather than left to the environment. P0-3 made
// `PAYMENT_SANDBOX` default to **false** so that the fail-open default became
// a fail-closed one, which is right — but nothing set it for tests, so from
// that commit onward every suite that pays for an order failed in CI while
// still passing for anyone whose shell happened to export it. Sixteen tests
// across six files, and the failure reads as a payments regression rather than
// as missing configuration.
//
// This does not weaken the P0-3 guard: `validateConfig` refuses the sandbox
// outright when `NODE_ENV=production`, and this file is loaded only by jest.
process.env.PAYMENT_SANDBOX ??= 'true';
