import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

import { ErrorCode } from '../constants/error-codes';
import { ApiErrorDto } from '../dto/api-error.dto';

interface NormalisedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: string[];
}

/**
 * Lowest status treated as a server fault. Kept as a plain number because the
 * values being compared come from `exception.getStatus()`, which is a `number`
 * and not a member of the `HttpStatus` enum.
 */
const SERVER_ERROR_MIN_STATUS = 500;

/** Fixed text for any server-side fault. Never varies with the underlying cause. */
const GENERIC_SERVER_MESSAGE = 'An internal error occurred.';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Converts every thrown value into the single {@link ApiErrorDto} envelope.
 *
 * Two rules this filter exists to guarantee:
 *  1. No internal detail (stack traces, SQL, driver text, credential fragments)
 *     ever reaches an API client — 5xx responses carry a fixed generic message.
 *  2. Every failure is logged server-side with its correlation ID, so an
 *     operator can reconstruct what the client could not be told.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const normalised = this.normalise(exception);
    const correlationId = typeof request.id === 'string' ? request.id : 'unknown';

    const body: ApiErrorDto = {
      statusCode: normalised.status,
      code: normalised.code,
      message: normalised.message,
      ...(normalised.details ? { details: normalised.details } : {}),
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
      correlationId,
    };

    this.log(exception, normalised, request, correlationId);

    response.status(normalised.status).json(body);
  }

  private normalise(exception: unknown): NormalisedError {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // A malformed query is a server-side defect, never the caller's fault to know about.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode.DATABASE_ERROR,
        message: GENERIC_SERVER_MESSAGE,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_SERVER_MESSAGE,
    };
  }

  private fromHttpException(exception: HttpException): NormalisedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const code = STATUS_TO_CODE[status] ?? this.defaultCodeForStatus(status);

    // Anything at 5xx may embed internal detail in its message — replace it.
    if (status >= SERVER_ERROR_MIN_STATUS) {
      return { status, code, message: GENERIC_SERVER_MESSAGE };
    }

    if (typeof payload === 'string') {
      return { status, code, message: payload };
    }

    const record = payload as { message?: unknown };
    const rawMessage = record.message;

    // ValidationPipe reports an array of field-level messages.
    if (Array.isArray(rawMessage)) {
      return {
        status,
        code,
        message: 'Request validation failed.',
        details: rawMessage.map((entry) => String(entry)),
      };
    }

    return {
      status,
      code,
      message: typeof rawMessage === 'string' ? rawMessage : exception.message,
    };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError): NormalisedError {
    // Messages are written here rather than forwarded, because Prisma error text
    // embeds table and column names that clients have no business seeing.
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'A record with these values already exists.',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'The requested resource was not found.',
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'The operation conflicts with a related record.',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.DATABASE_ERROR,
          message: GENERIC_SERVER_MESSAGE,
        };
    }
  }

  private defaultCodeForStatus(status: number): ErrorCode {
    return status >= SERVER_ERROR_MIN_STATUS
      ? ErrorCode.INTERNAL_ERROR
      : ErrorCode.VALIDATION_FAILED;
  }

  private log(
    exception: unknown,
    normalised: NormalisedError,
    request: Request,
    correlationId: string,
  ): void {
    // Method and path only — query strings and bodies can carry OTPs, tokens
    // and payment fields, so the query is split off and never written here.
    // `request.route.path` is deliberately not used: under a global prefix it
    // resolves to the framework's wildcard pattern rather than the real path.
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const context = `${request.method} ${path} [${correlationId}]`;

    if (normalised.status >= SERVER_ERROR_MIN_STATUS) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      const detail = exception instanceof Error ? exception.message : 'Non-error value thrown';
      this.logger.error(`${context} -> ${normalised.status} ${normalised.code}: ${detail}`, stack);
      return;
    }

    this.logger.warn(`${context} -> ${normalised.status} ${normalised.code}`);
  }
}
