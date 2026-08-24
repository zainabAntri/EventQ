import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { SessionExpiredError, TokenReuseDetectedError } from '../domain/auth.errors';
import { parseDurationSeconds } from '../../../shared/time/duration';

import type {
  AccessTokenClaims,
  IssuedTokens,
  SessionContext,
  SessionTokens,
} from '../domain/session-tokens.port';

/**
 * Access and refresh token lifecycle.
 *
 * Access token: a short-lived JWT. Stateless, so the common path needs no
 * database read.
 *
 * Refresh token: a long-lived OPAQUE random value, never a JWT. It is stored
 * only as a SHA-256 hash, so a database leak does not hand out live sessions.
 *
 * Rotation with reuse detection is the important part. Every refresh mints a
 * new token and marks the old one rotated. Presenting an already-rotated token
 * means it was captured, so the entire family is revoked. Without this, a
 * stolen refresh token grants indefinite access; with it, the theft costs the
 * attacker one request and logs the victim out, which is visible.
 */
@Injectable()
export class TokenService implements SessionTokens {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async issue(claims: AccessTokenClaims, context: SessionContext): Promise<IssuedTokens> {
    // A new family per login, so revoking one device's family never signs the
    // user out everywhere else.
    return this.mint(claims, randomUUID(), context);
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * Throws TokenReuseDetectedError if the token was already rotated, after
   * revoking every sibling in the family.
   */
  async rotate(
    presentedToken: string,
    context: SessionContext,
  ): Promise<{ tokens: IssuedTokens; claims: AccessTokenClaims }> {
    const tokenHash = this.hashToken(presentedToken);

    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: { orderBy: { createdAt: 'asc' }, take: 1 },
          },
        },
      },
    });

    if (!session) throw new SessionExpiredError();

    // Already rotated => this value was replayed. We cannot tell whether the
    // replay came from the legitimate client or a thief, so we assume the worst.
    if (session.rotatedAt !== null) {
      await this.revokeFamily(session.familyId);
      this.logger.warn(
        `Refresh token reuse detected; revoked family ${session.familyId} for user ${session.userId}`,
      );
      throw new TokenReuseDetectedError();
    }

    if (session.revokedAt !== null) throw new SessionExpiredError();
    if (session.expiresAt.getTime() <= Date.now()) throw new SessionExpiredError();

    const membership = session.user.memberships[0];
    if (!membership || session.user.deletedAt !== null) {
      await this.revokeFamily(session.familyId);
      throw new SessionExpiredError();
    }

    const claims: AccessTokenClaims = {
      sub: session.userId,
      org: membership.orgId,
      role: membership.role,
    };

    const tokens = await this.mint(claims, session.familyId, context);

    // Marked rotated rather than deleted: the row is what makes a later replay
    // detectable. Deleting it would turn reuse into an ordinary "not found".
    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { rotatedAt: new Date() },
    });

    return { tokens, claims };
  }

  /** Signs out one session. */
  async revoke(presentedToken: string): Promise<void> {
    const tokenHash = this.hashToken(presentedToken);
    await this.prisma.authSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Signs out every device in a family. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Signs out every session for a user. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.auth.accessSecret,
      });
    } catch {
      throw new SessionExpiredError('Your session has expired.');
    }
  }

  private async mint(
    claims: AccessTokenClaims,
    familyId: string,
    context: SessionContext,
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.auth.accessSecret,
      // Seconds rather than the raw "15m" string: jsonwebtoken types the string
      // form as a template literal, and a plain string does not satisfy it.
      expiresIn: parseDurationSeconds(this.config.auth.accessTtl),
    });

    // 256 bits of entropy. Opaque, so it carries no information and cannot be
    // decoded or tampered with the way a JWT can.
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(
      Date.now() + this.config.auth.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.authSession.create({
      data: {
        userId: claims.sub,
        tokenHash: this.hashToken(refreshToken),
        familyId,
        expiresAt: refreshExpiresAt,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        ipAddress: context.ipAddress?.slice(0, 64) ?? null,
      },
    });

    return { accessToken, refreshToken, refreshExpiresAt };
  }

  /**
   * SHA-256, not argon2.
   *
   * Deliberate: the token is 256 bits of random data, so there is no
   * low-entropy guess space for a slow hash to protect. A fast digest is the
   * right tool, and it keeps refresh cheap.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
