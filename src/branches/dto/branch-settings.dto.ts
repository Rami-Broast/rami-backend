import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trimOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Branch operating settings an admin can change — including turning delivery and
 * pickup on or off per branch. Every field optional: a PATCH updates only what
 * it sends.
 */
export class UpdateBranchSettingsDto {
  @ApiPropertyOptional({ description: 'Whether this branch offers delivery.' })
  @IsOptional()
  @IsBoolean()
  acceptsDelivery?: boolean;

  @ApiPropertyOptional({ description: 'Whether this branch offers pickup.' })
  @IsOptional()
  @IsBoolean()
  acceptsPickup?: boolean;

  @ApiPropertyOptional({ description: 'Master switch — whether the branch takes any orders now.' })
  @IsOptional()
  @IsBoolean()
  isAcceptingOrders?: boolean;

  @ApiPropertyOptional({ description: 'Whether cash on delivery is offered.' })
  @IsOptional()
  @IsBoolean()
  acceptsCashOnDelivery?: boolean;

  @ApiPropertyOptional({
    description:
      'When true (the default), a paid or COD order is CONFIRMED for the kitchen immediately. When false, staff must accept or reject each new order (§7).',
  })
  @IsOptional()
  @IsBoolean()
  autoAcceptOrders?: boolean;

  @ApiPropertyOptional({
    description:
      'Base delivery fee in minor units, charged on every delivery order. ' +
      'The owner-confirmed value is 500 (5 SAR).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  deliveryFeeMinor?: number;

  @ApiPropertyOptional({
    description:
      'How many km the base fee covers before the per-km fee applies. ' +
      'The owner-confirmed value is 5.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(500)
  deliveryBaseFeeCoversKm?: number;

  @ApiPropertyOptional({
    description:
      'Charged per started km beyond deliveryBaseFeeCoversKm, in minor units. ' +
      'The owner-confirmed value is 300 (3 SAR).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  deliveryPerKmFeeMinor?: number;

  @ApiPropertyOptional({
    description:
      'Multiplier turning straight-line distance into approximate road distance. ' +
      '1.3 is the usual urban figure; 1 charges the straight line as-is.',
    minimum: 1,
    maximum: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3)
  deliveryRoadFactor?: number;

  @ApiPropertyOptional({
    description:
      'Percentage added to item prices on delivery orders only, to cover the ' +
      'cost of delivering. Folded into the price the customer sees, not shown ' +
      'as a separate line. A product may override it. 0 disables it.',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  deliveryUpliftPercent?: number;

  @ApiPropertyOptional({
    description:
      'Minimum item subtotal for a delivery order, in minor units, measured ' +
      'before the delivery fee. Does not apply to pickup. The owner-confirmed ' +
      'value is 4000 (40 SAR).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  minOrderMinor?: number;

  @ApiPropertyOptional({
    description:
      'Furthest this branch will deliver, in km. Pass null to remove the limit ' +
      '— an empty field means "we deliver anywhere", not "unset".',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(500)
  deliveryRadiusKm?: number | null;

  @ApiPropertyOptional({ description: 'Estimated prep time in minutes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  prepTimeMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Printer model this branch uses (e.g. "epson-tm-t20iii"). Free-text — the adapter list in kitchen-pos grows as new models arrive. Pass "" or null to clear.',
    maxLength: 80,
    nullable: true,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{1,79}$/i, {
    message:
      'printerModel must be a short slug of letters, digits, dot, dash or underscore (e.g. "epson-tm-t20iii")',
  })
  @MaxLength(80)
  printerModel?: string | null;

  @ApiPropertyOptional({
    description:
      'How kitchen-pos reaches the printer (e.g. "qz-tray", "usb", "network"). Free-text — same growth rationale as printerModel. Pass "" or null to clear.',
    maxLength: 40,
    nullable: true,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{1,39}$/i, {
    message:
      'printerConnection must be a short slug of letters, digits, dot, dash or underscore (e.g. "qz-tray")',
  })
  @MaxLength(40)
  printerConnection?: string | null;
}
