import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** A manual loyalty adjustment by staff. */
export class AdjustLoyaltyDto {
  @ApiProperty({ description: 'The customer whose balance is adjusted.' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({
    description: 'Points to add (positive) or remove (negative). Never zero.',
    example: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  @NotEquals(0)
  points!: number;

  @ApiProperty({ description: 'Why the adjustment is being made. Audited.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
