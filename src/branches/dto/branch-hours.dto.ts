import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OpeningHoursEntryDto {
  @ApiProperty({ description: 'Day of week: 0 = Sunday … 6 = Saturday.', minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ description: 'Opening time as minutes from midnight (e.g. 480 = 08:00).' })
  @IsInt()
  @Min(0)
  @Max(1439)
  openMinute!: number;

  @ApiProperty({ description: 'Closing time as minutes from midnight (e.g. 1380 = 23:00).' })
  @IsInt()
  @Min(0)
  @Max(1439)
  closeMinute!: number;

  @ApiPropertyOptional({
    description: 'True if the branch is closed this entire day.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;
}

export class SetOpeningHoursDto {
  @ApiProperty({
    type: [OpeningHoursEntryDto],
    description: 'Full weekly schedule (replaces existing).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursEntryDto)
  hours!: OpeningHoursEntryDto[];
}

export class HoursOverrideDto {
  @ApiProperty({ description: 'Date in YYYY-MM-DD format.', example: '2026-09-01' })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional({
    description: 'Opening time as minutes from midnight. Omit for a closed day.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  openMinute?: number;

  @ApiPropertyOptional({ description: 'Closing time as minutes from midnight.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  closeMinute?: number;

  @ApiProperty({ description: 'True if the branch is closed on this date.', default: false })
  @IsBoolean()
  isClosed!: boolean;

  @ApiPropertyOptional({ description: 'Reason for the override (e.g. "Ramadan hours").' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  note?: string;
}
