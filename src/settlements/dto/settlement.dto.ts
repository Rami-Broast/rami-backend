import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Largest single payout amount accepted, in minor units — a sanity ceiling. */
const MAX_LINE_MINOR = 1_000_000_000;

/** One line of a gateway payout report. */
export class PayoutLineDto {
  @ApiProperty({ description: 'The gateway’s own identifier for the charge or refund.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  gatewayReference!: string;

  @ApiProperty({ enum: ['PAYMENT', 'REFUND'] })
  @IsIn(['PAYMENT', 'REFUND'])
  type!: 'PAYMENT' | 'REFUND';

  @ApiProperty({ description: 'Gross amount moved on this line, in minor units.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LINE_MINOR)
  amountMinor!: number;

  @ApiProperty({ description: 'Gateway fee charged on this line, in minor units.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LINE_MINOR)
  feeMinor!: number;
}

/**
 * A gateway payout report, submitted for reconciliation.
 *
 * The lines are the gateway's account of what it paid out; the service matches
 * them against our own captured payments and completed refunds for the same
 * period and branch scope. The payout is never trusted as the source of truth —
 * it is the thing being checked.
 */
export class IngestPayoutDto {
  @ApiProperty({ description: 'The payment gateway this payout is from.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  gatewayName!: string;

  @ApiProperty({
    description:
      'The gateway’s reference for this payout. Unique per gateway — re-submitting it is rejected.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  settlementReference!: string;

  @ApiProperty({ description: 'Start of the period this payout covers (ISO-8601 UTC).' })
  @IsISO8601()
  periodStart!: string;

  @ApiProperty({ description: 'End of the period this payout covers (ISO-8601 UTC).' })
  @IsISO8601()
  periodEnd!: string;

  @ApiPropertyOptional({ description: 'When the gateway paid out (ISO-8601 UTC).' })
  @IsOptional()
  @IsISO8601()
  payoutDate?: string;

  @ApiPropertyOptional({
    description:
      'Restrict reconciliation to one branch. Omit for an organisation-wide payout (owner only).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({ type: [PayoutLineDto], minItems: 0, maxItems: 5000 })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PayoutLineDto)
  lines!: PayoutLineDto[];

  @ApiPropertyOptional({ description: 'Free-text note recorded on the settlement.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Staff settlement listing filters. */
export class ListSettlementsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Restrict to one branch (validated against the caller’s scope).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;
}
