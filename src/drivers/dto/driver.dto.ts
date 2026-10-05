import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Parses a query-string boolean (`"true"` / `"false"`) without misreading `"false"` as truthy. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/** Staff provisioning a driver's operational profile for an existing DRIVER-role user. */
export class CreateDriverProfileDto {
  @ApiProperty({ description: 'The staff user holding the DRIVER role this profile belongs to.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({
    description:
      'The branch this driver works for. Defaults to the branch their DRIVER role is assigned to. Validated against the caller’s scope.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  licenseNumber?: string;

  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string;
}

export class UpdateDriverProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  licenseNumber?: string;

  @ApiPropertyOptional({ enum: VehicleType })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string;
}

/** Staff driver-listing filters, on top of the shared pagination parameters. */
export class ListDriversQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Restrict to one branch. Validated against the caller’s scope; owners may name any branch, branch staff only their own.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by shift status.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isOnline?: boolean;

  @ApiPropertyOptional({ description: 'Filter to drivers currently free for a new assignment.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isAvailable?: boolean;
}

/** A driver going on or off shift. */
export class SetOnlineStatusDto {
  @ApiProperty({
    description:
      'Going online makes the driver available for assignment (unless already on a delivery). Going offline always clears availability.',
  })
  @IsBoolean()
  isOnline!: boolean;
}

/**
 * A driver stepping away temporarily while still on shift (e.g. a break).
 *
 * Rejected while a delivery is in progress: availability is system-controlled
 * for as long as a driver holds work, and a break is by definition something
 * taken between jobs. While stepped away the driver is not offered new
 * assignments — see `DriversService.assertCanTakeAnotherJob`, which reads the
 * active-delivery count precisely so "stepped away" and "busy" stay different
 * things.
 */
export class SetDriverAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isAvailable!: boolean;
}

/** A driver's live location ping. */
export class UpdateDriverLocationDto {
  @ApiProperty()
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @IsLongitude()
  longitude!: number;
}
