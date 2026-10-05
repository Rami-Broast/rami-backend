import { randomInt } from 'node:crypto';

import { hash, verify, Algorithm } from '@node-rs/argon2';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';

import { AppConfigService } from '../../config/app-config.service';
import { maskPhone } from '../../notifications/sms/mock-sms.adapter';
import { SMS_SENDER, SmsSender } from '../../notifications/sms/sms.port';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  // Hashing a six-digit code is cheap to brute-force offline if the parameters
  // are weak, so the same memory-hard settings as passwords are used here.
  private readonly hashOptions = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {
    if (this.config.otp.demoFixedCode !== undefined) {
      // Loud warning at boot so an operator who leaves the demo override in
      // place has no plausible reason to be surprised by it. The value itself
      // is never logged.
      this.logger.warn(
        'OTP_DEMO_FIXED_CODE is set — every issued OTP will be the same fixed value. This is a demo-only affordance.',
      );
    }
  }

  /**
   * Issues a challenge and sends the code.
   *
   * Two limits apply: a cooldown between requests, and a ceiling per hour.
   * Without them a caller could pump SMS cost indefinitely, or grind through
   * codes by requesting a fresh challenge after each failed guess.
   */
  async request(phone: string, ipAddress?: string): Promise<{ expiresAt: Date }> {
    await this.enforceRequestLimits(phone);

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.config.otp.ttlSeconds * 1000);

    // Any earlier live challenge is invalidated, so only the newest code works.
    // Otherwise every resend would widen the set of valid codes.
    await this.prisma.otpChallenge.updateMany({
      where: { phone, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    });

    await this.prisma.otpChallenge.create({
      data: {
        phone,
        codeHash: await hash(code, this.hashOptions),
        purpose: OtpPurpose.CUSTOMER_LOGIN,
        maxAttempts: this.config.otp.maxAttempts,
        expiresAt,
        ipAddress,
      },
    });

    await this.sms.send({
      to: phone,
      body: `Your verification code is ${code}. It expires in ${Math.round(
        this.config.otp.ttlSeconds / 60,
      )} minutes.`,
      sensitive: true,
    });

    // The code is never logged, never returned, and never stored in plaintext.
    this.logger.log(`OTP challenge issued for ${maskPhone(phone)}`);

    return { expiresAt };
  }

  private async enforceRequestLimits(phone: string): Promise<void> {
    const now = Date.now();

    const mostRecent = await this.prisma.otpChallenge.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (mostRecent) {
      const elapsedSeconds = (now - mostRecent.createdAt.getTime()) / 1000;
      if (elapsedSeconds < this.config.otp.resendCooldownSeconds) {
        throw new HttpException(
          'Please wait before requesting another verification code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const lastHour = await this.prisma.otpChallenge.count({
      where: { phone, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    });

    if (lastHour >= this.config.otp.maxRequestsPerHour) {
      throw new HttpException(
        'Too many verification codes requested. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Verifies a submitted code and consumes the challenge.
   *
   * Every failure path returns the same message. Distinguishing "no challenge"
   * from "wrong code" from "expired" would tell an attacker which phone numbers
   * are registered and whether their guesses are landing.
   */
  async verify(phone: string, code: string): Promise<void> {
    const failure = new UnauthorizedException('The verification code is invalid or has expired.');

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) {
      throw failure;
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
      throw failure;
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      await this.invalidate(challenge.id);
      throw failure;
    }

    const matches = await verify(challenge.codeHash, code).catch(() => false);

    if (!matches) {
      const updated = await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true, maxAttempts: true },
      });

      // Burn the challenge once the budget is spent, so the attacker must go
      // back through the request rate limit to get another one.
      if (updated.attempts >= updated.maxAttempts) {
        await this.invalidate(challenge.id);
        this.logger.warn(`OTP challenge exhausted for ${maskPhone(phone)}`);
      }

      throw failure;
    }

    // Conditional update: `consumedAt: null` in the where clause means two
    // concurrent verifications of the same code cannot both succeed.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (consumed.count !== 1) {
      throw failure;
    }
  }

  private async invalidate(challengeId: string): Promise<void> {
    await this.prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { invalidatedAt: new Date() },
    });
  }

  /**
   * Uniformly random numeric code. `randomInt` is drawn from the CSPRNG —
   * `Math.random` is predictable and must never generate a credential.
   *
   * The demo override short-circuits this: when `OTP_DEMO_FIXED_CODE` is
   * configured (only permitted outside production, enforced at boot), every
   * challenge issues the same pinned value so a live demo audience without a
   * phone can still complete the login flow. The verification path is
   * unchanged — the challenge is hashed and stored the same way.
   */
  private generateCode(): string {
    const pinned = this.config.otp.demoFixedCode;
    if (pinned !== undefined) {
      return pinned;
    }

    const digits = Array.from({ length: this.config.otp.length }, () => randomInt(0, 10));

    if (digits.every((digit) => digit === digits[0])) {
      // Cosmetic guard against emitting 000000, which reads as a bug to users.
      digits[0] = (digits[0] + 1) % 10;
    }

    return digits.join('');
  }

  /** Removes expired and spent challenges. Called by a scheduled job. */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.otpChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });

    return result.count;
  }
}
