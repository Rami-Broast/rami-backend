import { randomBytes } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditOutcome } from '@prisma/client';

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit-actions';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { maskPhone } from '../notifications/sms/mock-sms.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { AuthTokensDto, CurrentActorDto } from './dto/auth.dto';
import { ActorService } from './services/actor.service';
import { OtpService } from './services/otp.service';
import { PasswordService } from './services/password.service';
import { IssuedTokens, TokenContext, TokenService } from './services/token.service';
import { Actor, ActorKind, isCustomer, isStaff } from './types/actor';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly actors: ActorService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * A genuine Argon2id hash of a random value, computed once on first use.
   *
   * Verifying against it burns the same CPU as verifying a real password, so
   * the "no such account" path costs what a wrong password costs and cannot be
   * distinguished by response time. It can never match a submitted password
   * because nothing knows the input.
   */
  private decoyHash?: Promise<string>;

  /**
   * Starts customer login.
   *
   * No customer record is created here and the response is identical whether or
   * not the number is known, so this endpoint cannot be used to test which
   * phone numbers have accounts.
   */
  async requestCustomerOtp(phone: string, ipAddress?: string): Promise<{ expiresAt: Date }> {
    return this.otp.request(phone, ipAddress);
  }

  /**
   * Completes customer login.
   *
   * The account is created on first successful verification — a customer proves
   * control of the number before any record exists, so an unverified phone can
   * never occupy one.
   */
  async verifyCustomerOtp(
    phone: string,
    code: string,
    context: TokenContext = {},
  ): Promise<AuthTokensDto> {
    await this.otp.verify(phone, code);

    const customer = await this.prisma.customer.upsert({
      where: { phone },
      update: { lastLoginAt: new Date(), phoneVerifiedAt: new Date() },
      create: { phone, phoneVerifiedAt: new Date(), lastLoginAt: new Date() },
    });

    if (!customer.isActive || customer.deletedAt !== null) {
      throw new UnauthorizedException('This account is not available.');
    }

    this.logger.log(`Customer authenticated: ${maskPhone(phone)}`);

    return this.toTokensDto(
      await this.tokens.issuePair({ kind: ActorKind.Customer, id: customer.id }, context),
    );
  }

  /**
   * Staff credential login.
   *
   * A password hash is verified even when no user matches, so that response
   * time does not reveal whether an address is registered.
   */
  async staffLogin(
    email: string,
    password: string,
    context: TokenContext = {},
  ): Promise<AuthTokensDto> {
    const failure = new UnauthorizedException('Invalid email or password.');

    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, passwordHash: true, isActive: true },
    });

    const passwordMatches = await this.verifyPasswordConstantish(user?.passwordHash, password);

    if (!user || !passwordMatches || !user.isActive) {
      // A failed attempt leaves no other trace, and a burst of them for one
      // address is what an incident review is looking for. The attempted email
      // is stored as the entity so the log can be filtered by it; no
      // credential is recorded. Attribution is SYSTEM — there is no proven
      // actor behind a failed login.
      await this.audit.record({
        action: AUDIT_ACTIONS.STAFF_LOGIN_FAILED,
        entityType: AUDIT_ENTITIES.AUTH,
        entityId: email,
        outcome: AuditOutcome.FAILURE,
        reason: 'Invalid email or password, or the account is inactive.',
      });
      throw failure;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    this.logger.log(`Staff authenticated: ${user.id}`);

    await this.audit.record({
      action: AUDIT_ACTIONS.STAFF_LOGIN,
      entityType: AUDIT_ENTITIES.USER,
      entityId: user.id,
      actorUserId: user.id,
    });

    return this.toTokensDto(
      await this.tokens.issuePair({ kind: ActorKind.Staff, id: user.id }, context),
    );
  }

  /**
   * Verifies against a decoy hash when the user does not exist, so that the
   * "no such account" path costs the same as a wrong password.
   */
  private async verifyPasswordConstantish(
    storedHash: string | undefined,
    password: string,
  ): Promise<boolean> {
    if (!storedHash) {
      await this.passwords.verify(await this.getDecoyHash(), password);
      return false;
    }

    return this.passwords.verify(storedHash, password);
  }

  private getDecoyHash(): Promise<string> {
    this.decoyHash ??= this.passwords.hash(randomBytes(32).toString('hex'));
    return this.decoyHash;
  }

  async refresh(refreshToken: string, context: TokenContext = {}): Promise<AuthTokensDto> {
    return this.toTokensDto(await this.tokens.rotate(refreshToken, context));
  }

  /** Logout. Idempotent, and reveals nothing about whether the token existed. */
  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeByToken(refreshToken);
  }

  describeActor(actor: Actor): CurrentActorDto {
    const branchScope =
      actor.branchScope.kind === 'ASSIGNED'
        ? { kind: 'ASSIGNED', branchIds: [...actor.branchScope.branchIds] }
        : { kind: actor.branchScope.kind };

    return {
      kind: actor.kind,
      id: actor.id,
      email: isStaff(actor) ? actor.email : undefined,
      fullName: isStaff(actor) ? actor.fullName : undefined,
      phone: isCustomer(actor) ? actor.phone : undefined,
      roles: isStaff(actor) ? [...actor.roles] : [],
      permissions: [...actor.permissions],
      branchScope,
    };
  }

  private toTokensDto(issued: IssuedTokens): AuthTokensDto {
    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresInSeconds: issued.expiresInSeconds,
      tokenType: 'Bearer',
    };
  }

  /** Resolves an actor for a verified token. */
  resolveActor(kind: ActorKind, id: string): Promise<Actor> {
    return this.actors.resolve(kind, id);
  }
}
