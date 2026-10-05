import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class CreateBranchDto {
  @ApiProperty({ description: 'Unique branch code (e.g. "BR-002").' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,19}$/, {
    message: 'code must be 2–20 uppercase letters, digits or dashes (e.g. "BR-002")',
  })
  code!: string;

  @ApiProperty({ description: 'Branch display name.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Arabic display name.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(120)
  nameAr?: string | null;

  @ApiPropertyOptional({ description: 'Branch phone number.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiProperty({ description: 'Street address.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  addressLine!: string;

  @ApiPropertyOptional({ description: 'District / neighbourhood.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(120)
  district?: string | null;

  @ApiProperty({ description: 'City.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  city!: string;

  @ApiPropertyOptional({ description: 'Latitude (decimal degrees).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  latitude?: number | null;

  @ApiPropertyOptional({ description: 'Longitude (decimal degrees).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  longitude?: number | null;
}

export class UpdateBranchDto {
  @ApiPropertyOptional({ description: 'Branch display name.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Arabic display name.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(120)
  nameAr?: string | null;

  @ApiPropertyOptional({ description: 'Branch phone number.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ description: 'Street address.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  addressLine?: string;

  @ApiPropertyOptional({ description: 'District / neighbourhood.' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(120)
  district?: string | null;

  @ApiPropertyOptional({ description: 'City.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ description: 'Latitude (decimal degrees).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  latitude?: number | null;

  @ApiPropertyOptional({ description: 'Longitude (decimal degrees).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  longitude?: number | null;
}

export class ChangeBranchStatusDto {
  @ApiProperty({
    enum: BranchStatus,
    description: 'Target status for the branch.',
  })
  @IsEnum(BranchStatus)
  status!: BranchStatus;

  @ApiPropertyOptional({ description: 'Reason for the status change (stored in audit).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DuplicateBranchDto {
  @ApiProperty({
    description: 'Unique code for the new branch (e.g. "BR-003").',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,19}$/, {
    message: 'code must be 2–20 uppercase letters, digits or dashes (e.g. "BR-003")',
  })
  code!: string;

  @ApiProperty({ description: 'Display name for the new branch.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description: 'Whether the new branch starts active. Defaults to false (draft).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

/**
 * Confirms an irreversible branch deletion.
 *
 * Two independent proofs, because the UI's "are you sure?" dialogs are not
 * security — they are a speed bump, and anything that can call this endpoint
 * has already skipped them.
 *
 * `password` proves it is really the signed-in operator at the keyboard and not
 * a borrowed session or a tab left open on a counter machine. `code` proves
 * they meant *this* branch: typing it out is the difference between deleting
 * the branch you were looking at and the one above it in the list.
 */
export class DeleteBranchDto {
  @ApiProperty({ description: 'The password the operator signs in with.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @ApiProperty({ description: "The branch's own code, typed back exactly." })
  @Transform(trimOrNull)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;
}
