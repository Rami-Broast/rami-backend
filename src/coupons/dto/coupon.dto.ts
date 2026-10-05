import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CouponRuleType, DiscountType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { IsImageRef } from '../../common/validators/image-ref.validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CouponRuleDto {
  @ApiProperty({ enum: CouponRuleType })
  @IsEnum(CouponRuleType)
  ruleType!: CouponRuleType;

  @ApiProperty({
    description:
      'Rule parameters, shape per ruleType, e.g. { "minSpendMinor": 5000 } or { "branchIds": ["…"] }.',
  })
  @IsObject()
  config!: Record<string, unknown>;
}

export class CreateCouponDto {
  @ApiProperty({ example: 'WELCOME10' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: '10% off your first order' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: DiscountType })
  @IsEnum(DiscountType)
  discountType!: DiscountType;

  @ApiProperty({
    description:
      'Percentage (e.g. "10" for 10%) or amount in minor units, per discountType. A decimal string — never a float.',
    example: '10',
  })
  @IsNumberString()
  discountValue!: string;

  @ApiPropertyOptional({ description: 'Ceiling for a percentage discount, in minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDiscountMinor?: number;

  @ApiProperty({ description: 'ISO-8601 UTC.' })
  @IsISO8601()
  validFrom!: string;

  @ApiProperty({ description: 'ISO-8601 UTC.' })
  @IsISO8601()
  validUntil!: string;

  @ApiPropertyOptional({ description: 'Total redemptions allowed across all customers.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalUsageLimit?: number;

  @ApiPropertyOptional({ description: 'Redemptions allowed per customer.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  @ApiPropertyOptional({ type: [CouponRuleDto], description: 'Eligibility rules, ANDed together.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CouponRuleDto)
  rules?: CouponRuleDto[];

  @ApiPropertyOptional({
    description:
      'List this coupon on the customer app’s Offers page, code and all. Off by default — ' +
      'a coupon is as often private or single-customer as it is a public promotion.',
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({
    description:
      'Artwork for the offer card. Upload via POST /assets and store the `/assets/<id>` path it returns; an absolute http(s) URL is also accepted for artwork referenced before uploading existed.',
  })
  @IsOptional()
  @IsImageRef()
  imageUrl?: string;
}

/**
 * What an owner may change on a coupon that already exists.
 *
 * Deliberately presentation and availability only. The code, the discount, the
 * validity window and the usage limits are the *terms* customers were given
 * when the coupon was handed out; editing those retroactively changes what
 * people were promised and what has already been redeemed under it. A different
 * offer is a different coupon.
 */
export class UpdateCouponDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'List it on the customer app’s Offers page.' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({ description: 'Stop the coupon being redeemable at all.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Artwork for the offer card. Null clears it.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsImageRef()
  imageUrl?: string | null;
}
