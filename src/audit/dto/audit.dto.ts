import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditOutcome } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Read-only filters for the audit log.
 *
 * The log is append-only and reached by owners for compliance / incident
 * review, so this is deliberately a search endpoint rather than a stream.
 * Every filter is optional; without any, it returns the newest 25 rows.
 */
export class ListAuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter to a specific action, e.g. "order.create".' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  action?: string;

  @ApiPropertyOptional({ description: 'Filter to a domain entity, e.g. "Order".' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Filter to a specific entity id.' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ description: 'Filter to actions performed by this staff user.' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'Filter to actions performed by this customer.' })
  @IsOptional()
  @IsUUID()
  actorCustomerId?: string;

  @ApiPropertyOptional({ description: 'Filter to actions targeting this branch.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: AuditOutcome })
  @IsOptional()
  @IsEnum(AuditOutcome)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Exclusive upper bound on createdAt (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({
    description: 'Trace a single request end to end via its correlation id.',
    maxLength: 120,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  correlationId?: string;
}
