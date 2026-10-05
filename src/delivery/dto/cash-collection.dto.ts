import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A driver recording how much cash they actually took from a customer.
 *
 * Amount in minor units, matching every other money field. The service copies
 * `expectedMinor` from the parent Payment at record time and computes the
 * variance server-side — the client never sends either.
 */
export class RecordCashCollectedDto {
  @ApiProperty({ description: 'Cash actually collected in minor units (halalas).', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  collectedMinor!: number;

  @ApiPropertyOptional({
    description:
      'Optional note (e.g. "customer paid extra, waived change" or "10 SAR short"). Never used to reshape the amount.',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Staff-side reconciliation filters. */
export class ListCashCollectionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by driver.' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Filter by branch (validated against caller scope).' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Exclusive upper bound on createdAt (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
