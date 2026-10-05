import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { AppConfigService } from '../config/app-config.service';
import { AppConfigModule } from '../config/config.module';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const LEGACY_REQUEST_ID_HEADER = 'x-request-id';

/**
 * Fields scrubbed from every log line.
 *
 * This list is the enforcement point for "never log secrets or sensitive
 * payment credentials". Add to it whenever a new module starts accepting
 * sensitive input — a redaction path costs nothing, a leaked OTP or PAN in a
 * log aggregator is unrecoverable.
 */
const REDACTED_PATHS = [
  // Credentials in transit
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',

  // Gateway webhook signatures
  'req.headers["x-tap-signature"]',
  'req.headers["tap-signature"]',
  'req.headers["x-mock-signature"]',

  // Authentication payloads
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.otp',
  'req.body.otpCode',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',

  // Cardholder data. The platform must never receive raw PAN/CVV — these paths
  // exist so that a mistake upstream is redacted rather than persisted.
  'req.body.card',
  'req.body.cardNumber',
  'req.body.pan',
  'req.body.cvv',
  'req.body.cvc',
  'req.body.expiry',

  // Customer PII a staff member types into the Branch POS counter-order form.
  'req.body.customerPhone',

  // Secrets that could appear in nested config or gateway payloads
  'req.body.secretKey',
  'req.body.apiKey',
  '*.secretKey',
  '*.privateKey',
  '*.certificate',
  // RestoPOS ZATCA per-branch API key — authorises issuing invoices on a
  // branch's chain, so it is never logged even when it appears nested.
  '*.apiKey',
];

/**
 * Resolves the correlation ID for a request: honours an inbound ID from the
 * gateway or a client app, otherwise mints one. The same value is echoed back
 * on the response so a client can quote it in a support ticket.
 */
function resolveCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const inbound =
    req.headers[CORRELATION_ID_HEADER] ?? req.headers[LEGACY_REQUEST_ID_HEADER] ?? undefined;

  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

  // Bound the length so a hostile client cannot inflate every log line.
  const correlationId =
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128
      ? candidate
      : randomUUID();

  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  return correlationId;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logging.level,
          genReqId: resolveCorrelationId,
          redact: {
            paths: REDACTED_PATHS,
            censor: '[REDACTED]',
            remove: false,
          },
          // Health probes would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') === true,
          },
          customProps: () => ({ service: 'backend' }),
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              // Query strings can carry identifiers and tokens; log path only.
              url: req.url?.split('?')[0],
            }),
          },
          transport: config.logging.pretty
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
