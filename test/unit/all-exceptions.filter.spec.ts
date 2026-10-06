import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ErrorCode } from '../../src/common/constants/error-codes';
import { ApiErrorDto } from '../../src/common/dto/api-error.dto';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const CORRELATION_ID = '3f1a0c2e-9f1b-4a5c-8f2d-1b2c3d4e5f60';

interface CapturedResponse {
  status: number;
  body: ApiErrorDto;
}

function createHost(overrides: Partial<{ url: string; method: string; id: unknown }> = {}): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const captured = { status: 0, body: {} as ApiErrorDto };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ApiErrorDto) {
      captured.body = body;
      return this;
    },
  };

  const request = {
    // `'id' in overrides` rather than an undefined check, so a test can
    // deliberately simulate a request that never received a correlation ID.
    id: 'id' in overrides ? overrides.id : CORRELATION_ID,
    method: overrides.method ?? 'POST',
    url: overrides.url ?? '/api/v1/orders',
    originalUrl: overrides.url ?? '/api/v1/orders',
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeAll(() => {
    // The filter logs every failure; silence it so test output stays readable.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  describe('envelope', () => {
    it('returns every documented field', () => {
      const { host, captured } = createHost();

      filter.catch(new NotFoundException('Order not found.'), host);

      expect(captured.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(captured.body).toEqual({
        statusCode: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'Order not found.',
        // Asserted by the matcher above; echoed here so the envelope is
        // compared exhaustively and an added field fails this test.
        timestamp: captured.body.timestamp,
        path: '/api/v1/orders',
        correlationId: CORRELATION_ID,
      });
    });

    it('falls back to a placeholder when no correlation ID was assigned', () => {
      const { host, captured } = createHost({ id: undefined });

      filter.catch(new NotFoundException(), host);

      expect(captured.body.correlationId).toBe('unknown');
    });
  });

  describe('leak prevention', () => {
    it('replaces an unknown error with a generic message', () => {
      const { host, captured } = createHost();

      filter.catch(new Error('connection refused to postgres://admin:hunter2@db:5432'), host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(captured.body.message).toBe('An internal error occurred.');
      expect(JSON.stringify(captured.body)).not.toContain('hunter2');
      expect(JSON.stringify(captured.body)).not.toContain('postgres://');
    });

    it('strips the message from an explicitly thrown 5xx', () => {
      const { host, captured } = createHost();

      filter.catch(
        new InternalServerErrorException('Tap secret key rejected: sk_live_abc123'),
        host,
      );

      expect(captured.body.message).toBe('An internal error occurred.');
      expect(JSON.stringify(captured.body)).not.toContain('sk_live_abc123');
    });

    it('does not expose a stack trace to the client', () => {
      const { host, captured } = createHost();

      filter.catch(new Error('boom'), host);

      expect(captured.body).not.toHaveProperty('stack');
      expect(JSON.stringify(captured.body)).not.toContain('at Object');
    });

    it('handles a thrown non-error value without crashing', () => {
      const { host, captured } = createHost();

      filter.catch('something went wrong', host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.message).toBe('An internal error occurred.');
    });
  });

  describe('validation failures', () => {
    it('surfaces field-level messages as details', () => {
      const { host, captured } = createHost();

      filter.catch(
        new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: ['email must be an email', 'quantity must not be less than 1'],
        }),
        host,
      );

      expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
      expect(captured.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(captured.body.message).toBe('Request validation failed.');
      expect(captured.body.details).toEqual([
        'email must be an email',
        'quantity must not be less than 1',
      ]);
    });

    it('omits details entirely when there are none', () => {
      const { host, captured } = createHost();

      filter.catch(new ForbiddenException('Branch access denied.'), host);

      expect(captured.body).not.toHaveProperty('details');
    });
  });

  describe('status to code mapping', () => {
    it.each([
      [new BadRequestException('bad'), HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED],
      [new ForbiddenException('nope'), HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
      [new NotFoundException('gone'), HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
      [
        new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS),
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
      ],
      [
        new HttpException('too big', HttpStatus.PAYLOAD_TOO_LARGE),
        HttpStatus.PAYLOAD_TOO_LARGE,
        ErrorCode.PAYLOAD_TOO_LARGE,
      ],
    ])('maps %#', (exception, expectedStatus, expectedCode) => {
      const { host, captured } = createHost();

      filter.catch(exception, host);

      expect(captured.status).toBe(expectedStatus);
      expect(captured.body.code).toBe(expectedCode);
    });
  });

  describe('Prisma errors', () => {
    const prismaError = (code: string) =>
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        {
          code,
          clientVersion: '6.0.0',
        },
      );

    it('maps a unique constraint violation to 409 without naming the column', () => {
      const { host, captured } = createHost();

      filter.catch(prismaError('P2002'), host);

      expect(captured.status).toBe(HttpStatus.CONFLICT);
      expect(captured.body.code).toBe(ErrorCode.CONFLICT);
      expect(captured.body.message).toBe('A record with these values already exists.');
      expect(JSON.stringify(captured.body)).not.toContain('email');
    });

    it('maps a missing record to 404', () => {
      const { host, captured } = createHost();

      filter.catch(prismaError('P2025'), host);

      expect(captured.status).toBe(HttpStatus.NOT_FOUND);
      expect(captured.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('maps a foreign key violation to 409', () => {
      const { host, captured } = createHost();

      filter.catch(prismaError('P2003'), host);

      expect(captured.status).toBe(HttpStatus.CONFLICT);
    });

    it('hides an unrecognised database error behind a 500', () => {
      const { host, captured } = createHost();

      filter.catch(prismaError('P2010'), host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(captured.body.message).toBe('An internal error occurred.');
    });
  });
});
