import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const lower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const upper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/**
 * Same 12-character floor as `scripts/create-staff-user.ts`, so an operator
 * cannot pick a weaker password through the admin UI than through the CLI.
 */
export const MINIMUM_STAFF_PASSWORD_LENGTH = 12;

/** Role name accepted at the API boundary — validated against the seeded roles in the service. */
const ROLE_PATTERN = /^[A-Z_]{2,32}$/;

/** Provision a new staff account, then optionally grant one role in the same call. */
export class CreateUserDto {
  @ApiProperty()
  @Transform(lower)
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty({ minLength: MINIMUM_STAFF_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MINIMUM_STAFF_PASSWORD_LENGTH)
  @MaxLength(200)
  password!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;

  @ApiPropertyOptional({
    description:
      'One of the seeded system roles (OWNER, BRANCH_ADMIN, KITCHEN, DRIVER). Optional at create time — a user with no role can be granted one later.',
  })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(ROLE_PATTERN, { message: 'role must be an uppercase role code' })
  role?: string;

  @ApiPropertyOptional({
    description:
      'Branch id the role is scoped to. Required for every role except OWNER, since a branch role with no branch grants nothing.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Fields a staff account owner can edit after creation. */
export class UpdateUserDto {
  @ApiPropertyOptional({
    description:
      'The sign-in address. Changing it changes what the person types to sign in, so every live session for that account is revoked.',
  })
  @IsOptional()
  @Transform(lower)
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({
    description: 'Set false to deactivate the account. Deactivation revokes all live sessions.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Sets a new password on behalf of a staff account (owner action). */
export class ResetPasswordDto {
  @ApiProperty({ minLength: MINIMUM_STAFF_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MINIMUM_STAFF_PASSWORD_LENGTH)
  @MaxLength(200)
  password!: string;
}

/** Grants a role to an existing user, optionally scoped to a branch. */
export class AssignRoleDto {
  @ApiProperty()
  @Transform(upper)
  @IsString()
  @Matches(ROLE_PATTERN, { message: 'role must be an uppercase role code' })
  role!: string;

  @ApiPropertyOptional({ description: 'Required for every role except OWNER.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Staff user-listing filters, on top of the shared pagination parameters. */
export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Free-text match on email or full name.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'Filter to users granted this role name.' })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(ROLE_PATTERN, { message: 'role must be an uppercase role code' })
  role?: string;

  @ApiPropertyOptional({ description: 'Filter to users assigned to this branch.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Include soft-deleted rows (default false).',
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeDeleted: boolean = false;
}
