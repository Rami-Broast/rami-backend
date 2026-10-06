import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp, configureOpenApi } from './bootstrap';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Defer to Pino so that boot-time logs share the format and redaction rules
    // of request logs rather than going to the console unfiltered.
    bufferLogs: true,
    // Capture the raw request body so payment-webhook signatures can be verified
    // against exactly what was received, not a re-serialised parse of it.
    rawBody: true,
  });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  const config = app.get(AppConfigService);

  configureApp(app, config);
  configureOpenApi(app, config);

  // Lets in-flight requests finish and Prisma disconnect cleanly on SIGTERM.
  app.enableShutdownHooks();

  await app.listen(config.app.port, '0.0.0.0');

  logger.log(
    {
      environment: config.app.env,
      port: config.app.port,
      docsEnabled: config.docs.enabled,
    },
    'Backend API started',
  );
}

void bootstrap();
