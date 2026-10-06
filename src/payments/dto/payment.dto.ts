import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** The online methods a customer may initiate a charge with (COD is not one). */
const ONLINE_METHODS: PaymentMethod[] = [
  PaymentMethod.CARD,
  PaymentMethod.MADA,
  PaymentMethod.APPLE_PAY,
  PaymentMethod.GOOGLE_PAY,
];

/** A customer initiating payment for one of their pending orders. */
export class InitiatePaymentDto {
  @ApiPropertyOptional({
    enum: ONLINE_METHODS,
    description: 'The online method to charge. Cash on delivery is settled at delivery, not here.',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  @IsIn(ONLINE_METHODS, { message: 'method must be an online payment method' })
  method?: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Where the gateway returns the customer after a hosted page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  returnUrl?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key for this payment attempt. Replaying the same key returns the existing attempt instead of charging twice.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

/** Staff payment listing filters. */
export class ListPaymentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Restrict to one branch (validated against the caller’s scope).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Restrict to one order.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

/** Sandbox-only: drive a mock charge to a terminal outcome. */
export class SimulateWebhookDto {
  @ApiProperty({ description: 'The gateway payment id returned when the charge was initiated.' })
  @IsString()
  @MaxLength(200)
  gatewayPaymentId!: string;

  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'], description: 'The outcome to simulate.' })
  @IsIn(['SUCCEEDED', 'FAILED'])
  outcome!: 'SUCCEEDED' | 'FAILED';

  @ApiPropertyOptional({ description: 'Override the captured amount in minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  amountMinor?: number;
}

/** Sandbox-only: drive a mock refund to a terminal outcome. */
export class SimulateRefundDto {
  @ApiProperty({ description: 'The gateway refund id returned when the refund was created.' })
  @IsString()
  @MaxLength(200)
  gatewayRefundId!: string;

  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'], description: 'The outcome to simulate.' })
  @IsIn(['SUCCEEDED', 'FAILED'])
  outcome!: 'SUCCEEDED' | 'FAILED';
}
