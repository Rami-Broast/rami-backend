import { INestApplication, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { ApiErrorDto } from './common/dto/api-error.dto';
import { AppConfigService } from './config/app-config.service';

export const API_PREFIX = 'api';
export const DOCS_PATH = 'api/docs';

/**
 * Applies every HTTP-level concern the application depends on.
 *
 * Both `main.ts` and the end-to-end tests call this, so the surface exercised by
 * tests cannot drift from the one served in production.
 */
export function configureApp(app: NestExpressApplication, config: AppConfigService): void {
  app.use(helmet());

  // Required for correct client IP resolution behind a load balancer, which
  // rate limiting and audit logging both depend on.
  if (config.app.trustedProxyHops > 0) {
    app.set('trust proxy', config.app.trustedProxyHops);
  }

  app.useBodyParser('json', { limit: config.app.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.app.bodyLimit, extended: true });

  // An empty allow-list permits no browser origin at all, which is the correct
  // default for a mobile-app-only deployment.
  if (config.app.corsAllowedOrigins.length > 0) {
    app.enableCors({
      origin: config.app.corsAllowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    });
  }

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

export function configureOpenApi(app: INestApplication, config: AppConfigService): void {
  if (!config.docs.enabled) {
    return;
  }

  const documentConfig = new DocumentBuilder()
    .setTitle('Restaurant Delivery Platform API')
    .setDescription(
      'Central backend API. Source of truth for customers, branches, menu, pricing, VAT, ' +
        'orders, payments, refunds, invoices, delivery, coupons, loyalty, notifications, ' +
        'settlements, reports and audit logs.',
    )
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'staff')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'customer')
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig, {
    extraModels: [ApiErrorDto],
  });

  SwaggerModule.setup(DOCS_PATH, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
