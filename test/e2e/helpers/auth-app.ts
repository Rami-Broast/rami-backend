import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/bootstrap';
import { AppConfigService } from '../../../src/config/app-config.service';
import { MockSmsAdapter } from '../../../src/notifications/sms/mock-sms.adapter';
import { SmsMessage, SmsSendResult } from '../../../src/notifications/sms/sms.port';

/**
 * Captures outbound SMS so tests can read the OTP that a real user would read
 * from their phone.
 *
 * The production adapter deliberately never logs or returns the code, so there
 * is no back door to reach for — a test has to intercept the message the same
 * way the customer receives it.
 */
export class CapturingSmsAdapter extends MockSmsAdapter {
  readonly sent: SmsMessage[] = [];

  override send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push(message);
    return super.send(message);
  }

  /** Extracts the numeric code from the most recent message to a number. */
  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((entry) => entry.to === phone);

    if (!message) {
      throw new Error(`No SMS was sent to ${phone}`);
    }

    const match = /\b(\d{4,10})\b/.exec(message.body);

    if (!match) {
      throw new Error('No code found in the SMS body');
    }

    return match[1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface AuthTestContext {
  app: NestExpressApplication;
  prisma: PrismaClient;
  sms: CapturingSmsAdapter;
  close: () => Promise<void>;
}

export interface AuthTestAppOptions {
  /**
   * Rate limiting is per client IP, and every test in a suite shares one. Left
   * on, the limiter would reject unrelated tests purely because of how many ran
   * before them — a flaky suite that tests nothing.
   *
   * So it is neutralised by default here, and verified deliberately in
   * `auth-rate-limit.e2e-spec.ts`, which turns it back on.
   *
   * Neutralising is done by swapping the throttler's *storage* rather than its
   * guard: guards registered through APP_GUARD are constructed by Nest and are
   * not reachable by `overrideGuard`, whereas storage is an ordinary injectable.
   * Nothing in production configuration changes — there is deliberately no
   * "disable rate limiting" switch for a deployed environment to get wrong.
   */
  throttle?: boolean;
}

/** Reports a single hit for every key, so no configured limit is ever reached. */
const NEVER_THROTTLES: ThrottlerStorage = {
  increment: () =>
    Promise.resolve({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
};

export async function createAuthTestApp(
  options: AuthTestAppOptions = {},
): Promise<AuthTestContext> {
  const sms = new CapturingSmsAdapter();

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MockSmsAdapter)
    .useValue(sms);

  if (options.throttle !== true) {
    builder.overrideProvider(ThrottlerStorage).useValue(NEVER_THROTTLES);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const prisma = new PrismaClient();
  await prisma.$connect();

  return {
    app,
    prisma,
    sms,
    close: async () => {
      await prisma.$disconnect();
      await app.close();
    },
  };
}

/** A phone number unique to each call, so tests never collide on rate limits. */
export function uniquePhone(): string {
  const suffix = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `+9665${suffix}`;
}
