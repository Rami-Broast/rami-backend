import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BannerAction } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

import { IsImageRef } from '../../common/validators/image-ref.validator';

export class CreateBannerDto {
  @ApiProperty({ description: 'Internal banner name.', example: 'Summer Sale Hero' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description:
      'Banner image (English). An uploaded `/assets/<id>` path, or an absolute http(s) URL.',
  })
  @IsImageRef()
  imageUrl!: string;

  @ApiPropertyOptional({ description: 'Banner image (Arabic). Same shapes as `imageUrl`.' })
  @IsOptional()
  @IsImageRef()
  imageUrlAr?: string;

  @ApiProperty({ description: 'Headline text (English).', example: 'Summer Sale!' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Headline text (Arabic).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleAr?: string;

  @ApiPropertyOptional({ description: 'Description (English).' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Description (Arabic).' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string;

  @ApiPropertyOptional({ description: 'Button label (English).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonText?: string;

  @ApiPropertyOptional({ description: 'Button label (Arabic).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonTextAr?: string;

  @ApiPropertyOptional({ enum: BannerAction, default: 'NONE' })
  @IsOptional()
  @IsEnum(BannerAction)
  action?: BannerAction;

  @ApiPropertyOptional({ description: 'Target entity ID (product, category, branch).' })
  @IsOptional()
  @IsString()
  targetId?: string;

  @ApiPropertyOptional({ description: 'External URL target.' })
  @IsOptional()
  @IsUrl()
  targetUrl?: string;

  @ApiPropertyOptional({
    description: 'Branch IDs this banner shows in. Empty = all.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  branchIds?: string[];

  @ApiPropertyOptional({ description: 'Sort priority (lower = first).', default: 0 })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ description: 'Start date in ISO format.' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ description: 'End date in ISO format.' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export class UpdateBannerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Banner image (English). Same shapes as on create.' })
  @IsOptional()
  @IsImageRef()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Banner image (Arabic). Same shapes as on create.' })
  @IsOptional()
  @IsImageRef()
  imageUrlAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonTextAr?: string;

  @ApiPropertyOptional({ enum: BannerAction })
  @IsOptional()
  @IsEnum(BannerAction)
  action?: BannerAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  targetUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  branchIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
