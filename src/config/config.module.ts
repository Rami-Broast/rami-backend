import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';
import { buildConfiguration } from './configuration';
import { validateEnv } from './env.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // `.env` is for local development only. Deployed environments inject real
      // values through secret management (see SECURITY.md).
      envFilePath: ['.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      cache: true,
      // Fails fast at boot on missing or malformed configuration.
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfigService,
      useFactory: (): AppConfigService => {
        // ConfigModule has already merged `.env` into process.env by the time
        // providers are constructed, so re-validating here yields the same
        // fully-defaulted instance that boot validation accepted.
        return new AppConfigService(buildConfiguration(validateEnv(process.env)));
      },
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}

export { AppConfigService } from './app-config.service';
