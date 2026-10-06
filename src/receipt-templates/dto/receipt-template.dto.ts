import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { DOCKET_SECTION_IDS } from '../receipt-template';

/**
 * The line lengths are not arbitrary. A docket prints on a 58mm or 80mm roll —
 * 32 or 42 characters — and a template is saved once and printed on every
 * order after it, so a header nobody can read is a fault that repeats until
 * somebody notices. The renderer wraps rather than truncates, so an overlong
 * line costs paper and legibility, not correctness.
 */
const MAX_LINE = 64;
const MAX_LINES = 6;

export class ReadyTimeRulesDto {
  @ApiProperty({ description: 'Above this items total, an order counts as large. Halalas.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  largeOrderThresholdMinor!: number;

  @ApiProperty({ type: [Number], description: '[from, to] minutes for a small order.' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(600, { each: true })
  smallOrderMinutes!: [number, number];

  @ApiProperty({ type: [Number], description: '[from, to] minutes for a large order.' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(600, { each: true })
  largeOrderMinutes!: [number, number];

  @ApiProperty({ description: 'Added to both ends of a delivery order.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  deliveryExtraMinutes!: number;
}

export class UpdateDocketTemplateDto {
  @ApiProperty({ enum: DOCKET_SECTION_IDS, isArray: true })
  @IsArray()
  @ArrayMaxSize(DOCKET_SECTION_IDS.length)
  @IsIn(DOCKET_SECTION_IDS, { each: true })
  sections!: string[];

  @ApiProperty({ description: "Print the restaurant's logo as an image at the top." })
  @IsBoolean()
  printLogoImage!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Artwork to use instead of the bundled brand mark. Null uses the bundled one.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2048)
  logoImageUrl!: string | null;

  @ApiProperty({
    minimum: 20,
    maximum: 100,
    description: 'Logo width as a percentage of the paper. 100 is edge to edge.',
  })
  @Type(() => Number)
  @IsInt()
  // Not below 20: a logo a fifth of a 58mm roll is 77 dots, which is a mark
  // nobody can identify and ink spent on nothing. Not above 100: wider than
  // the paper is what tears it across two lines.
  @Min(20)
  @Max(100)
  logoWidthPercent!: number;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @IsString({ each: true })
  @MaxLength(MAX_LINE, { each: true })
  logoLines!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @IsString({ each: true })
  @MaxLength(MAX_LINE, { each: true })
  brandLines!: string[];

  @ApiProperty()
  @IsBoolean()
  showBranchName!: boolean;

  @ApiProperty()
  @IsBoolean()
  showNewCustomerBadge!: boolean;

  @ApiProperty({ type: ReadyTimeRulesDto })
  @ValidateNested()
  @Type(() => ReadyTimeRulesDto)
  readyTimeRules!: ReadyTimeRulesDto;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @IsString({ each: true })
  @MaxLength(MAX_LINE, { each: true })
  thankYouLines!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @IsString({ each: true })
  @MaxLength(MAX_LINE, { each: true })
  footerLines!: string[];
}

/**
 * A branch's override, and it accepts **only** the fields a branch may set.
 *
 * `forbidNonWhitelisted` is on, so a branch sending the owner's layout does not
 * have it quietly ignored — the request is refused. That is the right way
 * round: a branch that believes it has changed the footer, and has not, prints
 * the wrong receipt for a month.
 */
export class UpdateBranchDocketOverrideDto {
  @ApiPropertyOptional({ type: ReadyTimeRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReadyTimeRulesDto)
  readyTimeRules?: ReadyTimeRulesDto;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @IsString({ each: true })
  @MaxLength(MAX_LINE, { each: true })
  thankYouLines?: string[];
}
