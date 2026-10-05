import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateFeatureFlagDto {
  @ApiProperty({ description: 'Whether the feature is enabled.' })
  @IsBoolean()
  enabled!: boolean;
}

export class CreateFeatureFlagDto {
  @ApiProperty({ description: 'Unique key for the feature flag.', example: 'online_payment' })
  @IsString()
  @MaxLength(100)
  key!: string;

  @ApiProperty({ description: 'Whether the feature is enabled.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Human-readable description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class FeatureFlagResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() updatedAt!: Date;
}
