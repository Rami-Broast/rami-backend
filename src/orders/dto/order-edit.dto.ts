import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A staff correction to an item that's already on a placed order.
 *
 * Deliberately narrow: only quantity / notes today. Adding or removing an
 * item after placement needs re-pricing and money-movement handling
 * (partial refund on a lower new total; additional charge on a higher one)
 * and is a follow-up on the money side; the audit surface here is ready
 * for those endpoints once they land.
 */
export class UpdateOrderItemDto {
  @ApiProperty({ description: 'New quantity. Minimum 1 — a removal is a separate action.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({
    description:
      'Free-text staff reason. Required — a manager needs to answer "why did this change?".',
    minLength: 3,
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}
