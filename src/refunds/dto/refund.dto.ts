import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** An authorized staff member issuing a full or partial refund. */
export class CreateRefundDto {
  @ApiProperty({ description: 'The payment to refund.' })
  @IsUUID()
  paymentId!: string;

  @ApiPropertyOptional({
    description:
      'Amount to refund in minor units. Omit for a full refund of the remaining refundable amount. Never exceeds it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor?: number;

  @ApiProperty({ description: 'Why the refund is being issued. Recorded and audited.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key. Replaying the same key returns the existing refund instead of issuing a second.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

/** Staff refund listing filters. */
export class ListRefundsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Restrict to one branch (validated against the caller’s scope).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: RefundStatus })
  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;

  @ApiPropertyOptional({ description: 'Restrict to one order.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
