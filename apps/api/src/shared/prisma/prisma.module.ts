import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global because a database handle is infrastructure every feature module
 * needs, and re-importing it a dozen times communicates nothing.
 *
 * Note that being global does NOT mean domain code may use it: the ESLint
 * boundary rules in @eventq/config forbid importing Prisma from domain/ or
 * application/. Repositories in infrastructure/ are the only consumers.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
