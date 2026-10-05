import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ErrorCode } from '../../src/common/constants/error-codes';
import { ApiErrorDto } from '../../src/common/dto/api-error.dto';
import { AppConfigService } from '../../src/config/app-config.service';
import { CORRELATION_ID_HEADER } from '../../src/logger/logger.module';

/** Shape of a Terminus health-check response. */
interface HealthResponse {
  status: string;
  info: Record<string, { status: string }>;
}

/** Shape of a liveness response. */
interface LivenessResponse {
  status: string;
  timestamp: string;
}

describe('Health and API conventions (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    app.useLogger(app.get(PinoLogger));

    // The same configuration main.ts applies — not a re-implementation of it.
    configureApp(app, app.get(AppConfigService));

    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /api/v1/health/live', () => {
    it('reports ok without touching the database', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      const body = response.body as LivenessResponse;

      expect(body.status).toBe('ok');
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('GET /api/v1/health/ready', () => {
    it('reports the database as up', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      const body = response.body as HealthResponse;

      expect(body.status).toBe('ok');
      expect(body.info).toHaveProperty('database');
      expect(body.info.database.status).toBe('up');
    });
  });

  describe('API versioning', () => {
    it('serves the versioned path', async () => {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    });

    it('does not serve an unversioned path', async () => {
      await request(app.getHttpServer()).get('/api/health/live').expect(404);
    });
  });

  describe('correlation IDs', () => {
    it('mints one when the client does not supply it', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(response.headers[CORRELATION_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('echoes back a client-supplied correlation ID', async () => {
      const supplied = 'order-checkout-42';

      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set(CORRELATION_ID_HEADER, supplied)
        .expect(200);

      expect(response.headers[CORRELATION_ID_HEADER]).toBe(supplied);
    });

    it('ignores an oversized correlation ID and mints its own', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set(CORRELATION_ID_HEADER, 'x'.repeat(500))
        .expect(200);

      expect(response.headers[CORRELATION_ID_HEADER]).not.toContain('xxxxx');
    });
  });

  describe('error envelope', () => {
    it('returns the documented shape for an unknown route', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      const body = response.body as ApiErrorDto;

      expect(body).toMatchObject({
        statusCode: 404,
        code: ErrorCode.NOT_FOUND,
        path: '/api/v1/does-not-exist',
      });
      expect(body.correlationId).toBeTruthy();
      expect(body.timestamp).toBeTruthy();
    });

    it('ties the error envelope to the response correlation header', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      const body = response.body as ApiErrorDto;

      expect(body.correlationId).toBe(response.headers[CORRELATION_ID_HEADER]);
    });

    it('never leaks a stack trace', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      expect(response.body).not.toHaveProperty('stack');
    });
  });

  describe('security headers', () => {
    it('sets the helmet defaults', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-dns-prefetch-control']).toBe('off');
      expect(response.headers).toHaveProperty('strict-transport-security');
    });

    it('does not advertise the server framework', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(response.headers).not.toHaveProperty('x-powered-by');
    });
  });

  describe('CORS', () => {
    it('rejects a browser origin by default', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', 'https://attacker.example.com')
        .expect(200);

      // No allow-list configured means no allow-origin header is ever echoed.
      expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    });
  });
});
