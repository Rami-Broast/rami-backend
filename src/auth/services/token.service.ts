import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken } from '@prisma/client';

import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorKind } from '../types/actor';

export interface AccessTokenPayload {
  /** Actor id. */
  sub: string;
  /** Actor kind, so a customer token can never be mistaken for a staff token. */
  typ: ActorKind;
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface TokenOwner {
  kind: ActorKind;
  id: string;
}

export interface TokenContext {
  userAgent?: string;
  ipAddress?: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Refresh tokens are hashed with SHA-256, not Argon2.
   *
   * That is deliberate and is not the same decision as password hashing: these
   * are 256 bits of cryptographic randomness, so there is no low-entropy guess
   * space to slow an attacker down over, and lookup has to be a single indexed
   * query rather than a scan of every stored hash.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private issueAccessToken(owner: TokenOwner): string {
    const payload: AccessTokenPayload = {
      sub: owner.id,
      typ: owner.kind,
      jti: randomUUID(),
    };

    return this.jwt.sign(payload, {
      secret: this.config.auth.accessTokenSecret,
      expiresIn: this.config.auth.accessTokenTtlSeconds,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.config.auth.accessTokenSecret,
      });
    } catch {
      // The specific reason (expired, malformed, bad signature) is withheld —
      // it tells an attacker how close they are.
      throw new UnauthorizedException('Invalid or expired token.');
    }
  }

  /**
   * Issues an access/refresh pair, starting a new rotation family.
   */
  async issuePair(owner: TokenOwner, context: TokenContext = {}): Promise<IssuedTokens> {
    return this.issueWithinFamily(owner, randomUUID(), context);
  }

  private async issueWithinFamily(
    owner: TokenOwner,
    familyId: string,
    context: TokenContext,
  ): Promise<IssuedTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        familyId,
        expiresAt,
        userId: owner.kind === ActorKind.Staff ? owner.id : null,
        customerId: owner.kind === ActorKind.Customer ? owner.id : null,
        userAgent: context.userAgent?.slice(0, 512),
        ipAddress: context.ipAddress,
      },
    });

    return {
      accessToken: this.issueAccessToken(owner),
      refreshToken,
      expiresInSeconds: this.config.auth.accessTokenTtlSeconds,
    };
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * Rotation with reuse detection: each refresh revokes the presented token and
   * issues a successor in the same family. If a token that was already rotated
   * is presented again, it has been replayed — which in practice means it was
   * stolen — so the entire family is revoked. That logs out the attacker and
   * the legitimate holder together, which is the correct outcome once a
   * credential is known to be compromised.
   */
  async rotate(presentedToken: string, context: TokenContext = {}): Promise<IssuedTokens> {
    const tokenHash = this.hashToken(presentedToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (stored.revokedAt !== null) {
      await this.revokeFamily(stored.familyId, 'Reuse of a rotated refresh token detected');
      this.logger.warn(`Refresh token reuse detected; revoked family ${stored.familyId}`);
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    const owner = this.ownerOf(stored);

    // Revoke first: if issuing the successor fails, the presented token is
    // already spent, which fails closed rather than leaving it replayable.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), revokedReason: 'Rotated', lastUsedAt: new Date() },
    });

    return this.issueWithinFamily(owner, stored.familyId, context);
  }

  private ownerOf(token: RefreshToken): TokenOwner {
    if (token.userId !== null) {
      return { kind: ActorKind.Staff, id: token.userId };
    }

    if (token.customerId !== null) {
      return { kind: ActorKind.Customer, id: token.customerId };
    }

    // Unreachable while the RefreshToken_exactly_one_owner CHECK constraint
    // holds; treated as a failure rather than assumed away.
    throw new UnauthorizedException('Invalid refresh token.');
  }

  /** Revokes every live token in a rotation family. */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Logout. Revokes the presented token's whole family. */
  async revokeByToken(presentedToken: string, reason = 'Signed out'): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(presentedToken) },
    });

    // Logout is idempotent: an unknown or already-revoked token is not an
    // error, and must not reveal whether the token existed.
    if (stored) {
      await this.revokeFamily(stored.familyId, reason);
    }
  }

  /** Revokes every session for an actor — used when access is withdrawn. */
  async revokeAllForActor(owner: TokenOwner, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: {
        revokedAt: null,
        ...(owner.kind === ActorKind.Staff ? { userId: owner.id } : { customerId: owner.id }),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }
}
