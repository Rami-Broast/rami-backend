import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChargeAppliesTo, ChargeType, TaxClass } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class ChargeConditionsDto {
  @ApiPropertyOptional({
    description: 'Order types this charge applies to.',
    example: ['DELIVERY'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orderTypes?: string[];

  @ApiPropertyOptional({ description: 'Minimum subtotal in minor units for this charge to apply.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minSubtotalMinor?: number;

  @ApiPropertyOptional({ description: 'Maximum subtotal in minor units for this charge to apply.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxSubtotalMinor?: number;

  @ApiPropertyOptional({
    description: 'Payment methods this charge applies to.',
    example: ['ONLINE'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  paymentMethods?: string[];
}

export class CreateChargeDto {
  @ApiProperty({ description: 'Charge name (English).', example: 'Service Fee' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: 'Charge name (Arabic).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameAr?: string;

  @ApiProperty({ enum: ChargeType, description: 'How the charge is calculated.' })
  @IsEnum(ChargeType)
  type!: ChargeType;

  @ApiPropertyOptional({
    enum: ChargeAppliesTo,
    description: 'What the percentage is based on.',
    default: 'SUBTOTAL',
  })
  @IsOptional()
  @IsEnum(ChargeAppliesTo)
  appliesTo?: ChargeAppliesTo;

  @ApiPropertyOptional({
    description: 'Fixed amount in minor units. Required for FIXED and PER_ITEM.',
  })
  @ValidateIf((o: CreateChargeDto) => o.type === ChargeType.FIXED || o.type === ChargeType.PER_ITEM)
  @IsInt()
  @Min(0)
  amountMinor?: number;

  @ApiPropertyOptional({
    description: 'Percentage in basis points (100 = 1%). Required for PERCENTAGE.',
  })
  @ValidateIf((o: CreateChargeDto) => o.type === ChargeType.PERCENTAGE)
  @IsInt()
  @Min(0)
  percentBps?: number;

  @ApiPropertyOptional({ description: 'Whether VAT applies to this charge.', default: true })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({
    enum: TaxClass,
    description: 'Tax class for VAT calculation.',
    default: 'STANDARD',
  })
  @IsOptional()
  @IsEnum(TaxClass)
  taxClass?: TaxClass;

  @ApiPropertyOptional({
    description: 'Branch IDs this charge applies to. Null = all branches.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  branchIds?: string[];

  @ApiPropertyOptional({
    description: 'Conditions for when this charge applies.',
    type: ChargeConditionsDto,
  })
  @IsOptional()
  @IsObject()
  @Type(() => ChargeConditionsDto)
  conditions?: ChargeConditionsDto;

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

  @ApiPropertyOptional({ description: 'Whether this charge is active.', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateChargeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameAr?: string;

  @ApiPropertyOptional({ enum: ChargeType })
  @IsOptional()
  @IsEnum(ChargeType)
  type?: ChargeType;

  @ApiPropertyOptional({ enum: ChargeAppliesTo })
  @IsOptional()
  @IsEnum(ChargeAppliesTo)
  appliesTo?: ChargeAppliesTo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  amountMinor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  percentBps?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ enum: TaxClass })
  @IsOptional()
  @IsEnum(TaxClass)
  taxClass?: TaxClass;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  branchIds?: string[];

  @ApiPropertyOptional({ type: ChargeConditionsDto })
  @IsOptional()
  @IsObject()
  @Type(() => ChargeConditionsDto)
  conditions?: ChargeConditionsDto;

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
