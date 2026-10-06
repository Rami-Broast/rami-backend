import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryStatus, ProofOfDeliveryType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Staff assigning a driver to a delivery awaiting one. */
export class AssignDriverDto {
  @ApiProperty({ description: 'Must be an online, available driver.' })
  @IsUUID()
  driverId!: string;
}

export class UnassignDriverDto {
  @ApiPropertyOptional({
    description: 'Why the delivery was taken off its driver. Recorded on the history row.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Staff delivery-listing filters, on top of the shared pagination parameters. */
export class ListDeliveriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Restrict to one branch. Validated against the caller’s scope; owners may name any branch, branch staff only their own.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: DeliveryStatus })
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  driverId?: string;
}

/** A driver's own delivery-listing filters. */
export class MyDeliveriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DeliveryStatus })
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;
}

/** An optional location captured with a driver-initiated update. */
export class DeliveryLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

/** Marking a delivery picked up or out for delivery. */
export class DeliveryProgressDto extends DeliveryLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Marking a delivery complete.
 *
 * `proofUrl` is required for `SIGNATURE`/`PHOTO` — the client uploads the
 * capture to object storage and passes back the resulting URL; this backend
 * never handles the upload itself. `OTP` is accepted as a proof-method label
 * only: verifying a delivery code against a real challenge needs its own OTP
 * purpose and dispatch flow, which is not yet built (see
 * `src/delivery/README.md`) — it is not silently faked here.
 */
export class MarkDeliveredDto extends DeliveryLocationDto {
  @ApiProperty({ enum: ProofOfDeliveryType })
  @IsEnum(ProofOfDeliveryType)
  proofType!: ProofOfDeliveryType;

  @ApiPropertyOptional({ description: 'Required when proofType is SIGNATURE or PHOTO.' })
  @ValidateIf((dto: MarkDeliveredDto) => dto.proofType === 'SIGNATURE' || dto.proofType === 'PHOTO')
  @IsString()
  @MaxLength(1000)
  proofUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  recipientName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** A delivery that could not be completed after pickup. */
export class MarkDeliveryFailedDto extends DeliveryLocationDto {
  @ApiProperty({ description: 'Why the delivery could not be completed.' })
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason!: string;
}
