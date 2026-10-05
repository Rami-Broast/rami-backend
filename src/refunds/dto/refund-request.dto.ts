import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundRequestStatus, RefundRequestType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/** A customer asking the branch to cancel an order or return their money. */
export class CreateRefundRequestDto {
  @ApiProperty({
    description:
      'Why, in the customer’s own words. Shown to staff verbatim — it is the whole basis on which someone decides.',
    maxLength: 1000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

/** Staff approving a request. */
export class ApproveRefundRequestDto {
  @ApiPropertyOptional({
    description:
      'Amount to refund in minor units. Omit to refund everything still refundable on the order’s payment. Never exceeds it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor?: number;

  @ApiPropertyOptional({
    description: 'A note the customer reads with the decision.',
    maxLength: 1000,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Whether approving should also cancel the order. Defaults to true for a cancellation request whose order can still legally be cancelled, and false otherwise — an order past pickup cannot be cancelled, and a refund never moves fulfilment on its own.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  cancelOrder?: boolean;
}

/**
 * The owner recording a refund they issued in the payment gateway's own
 * dashboard. Owner-only (`refunds:write`) — the branch decides, the owner pays.
 */
export class RecordRefundIssuedDto {
  @ApiProperty({
    description:
      'The gateway’s own reference for the refund, copied from its dashboard. This is what ties our record to its line on the payout at reconciliation, so it is required — a refund recorded with no reference cannot be matched to anything later.',
    maxLength: 200,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  gatewayReference!: string;

  @ApiPropertyOptional({
    description:
      'What was actually paid out, in minor units. Omit to record the amount the branch approved. Never exceeds what is still refundable.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor?: number;

  @ApiPropertyOptional({ description: 'A note kept on the refund record.', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Staff refusing a request. */
export class RejectRefundRequestDto {
  @ApiProperty({
    description:
      'Why it is being refused. Required — the customer reads this, and "no" with no reason is what turns one refusal into three phone calls.',
    maxLength: 1000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

/** Staff queue filters. */
export class ListRefundRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Restrict to one branch (validated against the caller’s scope).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: RefundRequestStatus })
  @IsOptional()
  @IsEnum(RefundRequestStatus)
  status?: RefundRequestStatus;

  @ApiPropertyOptional({ enum: RefundRequestType })
  @IsOptional()
  @IsEnum(RefundRequestType)
  type?: RefundRequestType;

  @ApiPropertyOptional({ description: 'Restrict to one order.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({
    description:
      'Only approved requests whose refund has not been recorded yet — the owner’s payout queue. `false` returns those already paid out.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  awaitingPayout?: boolean;
}

/** A customer listing their own requests. */
export class MyRefundRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RefundRequestStatus })
  @IsOptional()
  @IsEnum(RefundRequestStatus)
  status?: RefundRequestStatus;

  @ApiPropertyOptional({
    description:
      'Restrict to one order. The order screen uses this to show what was decided — the eligibility check says whether another request can be raised, not what happened to the last one.',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
