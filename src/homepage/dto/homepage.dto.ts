import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HomepageSectionKind } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpsertHomepageSectionDto {
  @ApiProperty({ enum: HomepageSectionKind })
  @IsEnum(HomepageSectionKind)
  kind!: HomepageSectionKind;

  @ApiPropertyOptional({ description: 'Section heading (English).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Section heading (Arabic).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleAr?: string;

  @ApiPropertyOptional({ description: 'Display order (lower = first).', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional({ description: 'Whether this section is visible.', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Section-specific configuration (JSON).' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class ReorderHomepageDto {
  @ApiProperty({
    description: 'Ordered list of section IDs, from top to bottom.',
    type: [String],
  })
  @IsString({ each: true })
  sectionIds!: string[];
}
