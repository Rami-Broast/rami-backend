import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ErrorCode } from '../constants/error-codes';

/**
 * The single error envelope returned by every endpoint.
 *
 * Documented as a DTO so that all five client apps can generate one shared
 * error type from the OpenAPI schema.
 */
export class ApiErrorDto {
  @ApiProperty({ example: 400, description: 'HTTP status code.' })
  statusCode!: number;

  @ApiProperty({
    enum: ErrorCode,
    example: ErrorCode.VALIDATION_FAILED,
    description: 'Stable machine-readable error code. Branch on this, not on `message`.',
  })
  code!: ErrorCode;

  @ApiProperty({
    example: 'Request validation failed.',
    description: 'Human-readable summary. Safe to surface, never contains internal detail.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['email must be an email'],
    description: 'Field-level validation messages, present only for validation failures.',
  })
  details?: string[];

  @ApiProperty({
    example: '2026-01-01T12:00:00.000Z',
    description: 'Server timestamp in ISO-8601 (UTC).',
  })
  timestamp!: string;

  @ApiProperty({ example: '/api/v1/health/ready', description: 'Request path.' })
  path!: string;

  @ApiProperty({
    example: '3f1a0c2e-9f1b-4a5c-8f2d-1b2c3d4e5f60',
    description:
      'Correlation ID. Quote this when reporting an issue — it ties the response to server logs.',
  })
  correlationId!: string;
}
