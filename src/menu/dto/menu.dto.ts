import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { TaxClass } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Largest accepted price: 100,000.00 SAR in halalas. Guards against a typo. */
const MAX_PRICE_MINOR = 10_000_000;

export class CreateCategoryDto {
  @ApiProperty({ example: 'Main Dishes' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'الأطباق الرئيسية' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageUrl?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateProductDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'Grilled Chicken' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Stock keeping unit. Must be unique.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageUrl?: string;

  @ApiProperty({
    example: 3250,
    description:
      'Price in minor units (halalas), VAT inclusive. 3250 is 32.50 SAR. Never sent as a decimal.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  basePriceMinor!: number;

  @ApiPropertyOptional({
    example: 8,
    nullable: true,
    minimum: 0,
    maximum: 100,
    description:
      'Overrides the branch delivery uplift for this product only. Null (or ' +
      'omitted) uses the branch default; 0 means "never uplift this item" and ' +
      'is respected as a deliberate choice, not treated as unset.',
  })
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  deliveryUpliftPercent?: number | null;

  @ApiPropertyOptional({ enum: TaxClass, default: TaxClass.STANDARD })
  @IsOptional()
  @IsEnum(TaxClass)
  taxClass?: TaxClass;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether the product is active in the catalogue. Accepted on create so a product can be prepared as a draft and switched on later, which is what the admin app’s new-product form offers.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class SetAvailabilityDto {
  @ApiProperty({ description: 'Whether this branch currently sells the product.' })
  @IsBoolean()
  isAvailable!: boolean;

  @ApiPropertyOptional({
    example: 3500,
    description: 'Branch-specific price in minor units. Omit or null to use the catalog price.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceOverrideMinor?: number | null;

  @ApiPropertyOptional({
    example: '2026-09-04T18:00:00.000Z',
    description:
      'When a temporary stock-out ends, as an ISO-8601 instant in UTC. While it ' +
      'is in the future the product is unavailable regardless of isAvailable; ' +
      'once it passes the product sells again with no further request. Cleared ' +
      'automatically when isAvailable is set true.',
  })
  @IsOptional()
  @IsISO8601()
  unavailableUntil?: string;
}

/** One line of a cart, as sent by a client. Notably, no price. */
export class CartItemDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @ApiProperty({ minimum: 1, maximum: 999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  addonIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class QuoteCartDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty({ enum: ['DELIVERY', 'PICKUP'] })
  @IsEnum({ DELIVERY: 'DELIVERY', PICKUP: 'PICKUP' })
  type!: 'DELIVERY' | 'PICKUP';

  @ApiProperty({ type: [CartItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}

// --- Variants ---------------------------------------------------------------

export class CreateVariantDto {
  @ApiProperty({ example: 'Large' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: 'كبير' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @ApiPropertyOptional({ description: 'Stock keeping unit. Must be unique when set.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiProperty({
    example: 4500,
    description:
      'Absolute price for this variant in minor units (halalas), VAT inclusive. It replaces the product base price — it is not a delta.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMinor!: number;

  @ApiPropertyOptional({
    default: false,
    description: 'The variant selected by default. At most one per product.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateVariantDto extends PartialType(CreateVariantDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// --- Modifier groups and add-ons -------------------------------------------

export class CreateModifierGroupDto {
  @ApiProperty({ example: 'Choose your sauce' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: 'اختر الصلصة' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @ApiPropertyOptional({
    default: 0,
    description: 'Minimum selections a customer must make. Must not exceed maxSelections.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  minSelections?: number;

  @ApiPropertyOptional({ default: 1, description: 'Maximum selections a customer may make.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxSelections?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}

export class UpdateModifierGroupDto extends PartialType(CreateModifierGroupDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAddonDto {
  @ApiProperty({ example: 'Garlic sauce' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @ApiPropertyOptional({
    default: 0,
    description: 'Add-on surcharge in minor units (halalas), VAT inclusive.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMinor?: number;

  @ApiPropertyOptional({ enum: TaxClass, default: TaxClass.STANDARD })
  @IsOptional()
  @IsEnum(TaxClass)
  taxClass?: TaxClass;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateAddonDto extends PartialType(CreateAddonDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AttachModifierGroupDto {
  @ApiProperty({ description: 'The modifier group to attach to this product.' })
  @IsUUID()
  modifierGroupId!: string;

  @ApiPropertyOptional({ default: 0, description: 'Order among this product’s modifier groups.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}
