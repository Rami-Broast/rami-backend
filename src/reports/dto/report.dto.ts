import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * The shared query for every report: a time window and an optional branch.
 *
 * `from`/`to` are inclusive ISO-8601 UTC bounds. The branch is validated
 * against the caller's scope — an owner may name any branch or none (all they
 * can reach); branch staff are restricted to their assignments whether they
 * name a branch or not.
 */
export class ReportQueryDto {
  @ApiProperty({ description: 'Start of the reporting window (ISO-8601 UTC), inclusive.' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'End of the reporting window (ISO-8601 UTC), inclusive.' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({
    description: 'Restrict to one branch (validated against the caller’s scope).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
