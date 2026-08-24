import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './presentation/auth.controller';
import { RegisterOrganizerUseCase } from './application/register-organizer.use-case';
import { LoginOrganizerUseCase } from './application/login-organizer.use-case';
import {
  GetCurrentOrganizerUseCase,
  RefreshSessionUseCase,
  SignOutUseCase,
  StartSessionUseCase,
} from './application/session.use-cases';
import { TokenService } from './infrastructure/token.service';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher';
import { PrismaOrganizerRepository } from './infrastructure/prisma-organizer.repository';
import { PASSWORD_HASHER } from './domain/password-hasher.port';
import { ORGANIZER_REPOSITORY } from './domain/organizer.repository';
import { SESSION_TOKENS } from './domain/session-tokens.port';

/**
 * The one place where domain ports meet their concrete adapters.
 *
 * Re-tuning argon2, swapping the token format, or moving organizers off Prisma
 * touches only infrastructure/ and this provider list. Nothing in application/
 * or domain/ changes.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    // Application
    RegisterOrganizerUseCase,
    LoginOrganizerUseCase,
    StartSessionUseCase,
    RefreshSessionUseCase,
    SignOutUseCase,
    GetCurrentOrganizerUseCase,

    // Infrastructure, bound to the ports the domain declares
    Argon2PasswordHasher,
    PrismaOrganizerRepository,
    TokenService,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
    { provide: ORGANIZER_REPOSITORY, useExisting: PrismaOrganizerRepository },
    { provide: SESSION_TOKENS, useExisting: TokenService },
  ],
  // Exported as the PORT, not the class: the global AuthGuard verifies access
  // tokens through the interface and never learns which implementation it got.
  exports: [SESSION_TOKENS],
})
export class AuthModule {}
