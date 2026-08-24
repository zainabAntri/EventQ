import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';
import { AppConfigService } from './app-config.service';

/**
 * Global configuration module.
 *
 * Global because configuration is a genuine cross-cutting concern — the
 * alternative is importing it into every one of a dozen feature modules, which
 * is noise rather than explicitness.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Validated once, at boot. An invalid environment stops the process here.
      validate: validateEnv,
      cache: true,
      expandVariables: true,
      envFilePath: ['.env'],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
